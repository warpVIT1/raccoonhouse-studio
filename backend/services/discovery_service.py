"""
Peer discovery and control-plane transport for power-sharing, entirely over
one persistent WebSocket to a Cloudflare Worker (see cloudflare-signaling/):

  - Presence — "who's online right now", pushed by the Worker whenever the
    online set changes.
  - Consent handshake and job control ("can I use your PC?", "here's the
    job", "done"/"failed") — relayed through the Worker's `relay` message
    type between two specific peers, never touching either side's IP.
  - The actual file transfer for a job (audio/video in, processed stem/audio
    out) goes over plain HTTPS to the same Worker's /transfer/:id routes,
    which store-and-forward through an R2 bucket (see upload_transfer /
    download_transfer below). This intentionally isn't part of the
    WebSocket protocol — Cloudflare Workers have per-request CPU/duration
    limits that make relaying multi-gigabyte files through a request/
    response, or through WS messages, a bad fit.

There is no LAN broadcast and no manual pinned-IP fallback anymore: two
RaccoonHouse instances need nothing in common except both being connected to
the same Worker, so there's no "different network" or "VPN mesh doesn't
relay broadcast" case left to work around.
"""
import asyncio
import json
import os
import shutil
import tempfile
import threading
import time
import uuid

import requests
from websockets.sync.client import connect as ws_connect
from websockets.exceptions import WebSocketException

from .gpu_service import get_gpu_info
from . import power_share_service as pss

ONLINE_SIGNALING_HEARTBEAT_SECONDS = 5
ONLINE_SIGNALING_RECONNECT_SECONDS = 5
STALE_AFTER_SECONDS = 12
RELAY_CALL_DEFAULT_TIMEOUT = 70

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
_CLIENT_ID_FILE = os.path.join(DATA_DIR, ".power_share_client_id")


def _get_or_create_client_id() -> str:
    """A stable id for this install, persisted to disk — used as this
    client's signaling id on every connection. Without this, the Worker
    would hand out a fresh random id on every single WebSocket reconnect
    (see cloudflare-signaling/src/index.ts), and any relay reply addressed
    to the OLD id (a consent response, or a job's result) would silently
    have nowhere to go the moment a reconnect happens mid-request — exactly
    what made a real request hang forever after a network blip, confirmed
    live 2026-07-21 from a requester's power_share.log showing a DISPATCH
    with no matching DISPATCH-RESPONSE ever, followed by WS reconnects."""
    try:
        if os.path.isfile(_CLIENT_ID_FILE):
            existing = open(_CLIENT_ID_FILE, "r", encoding="utf-8").read().strip()
            if existing:
                return existing
    except OSError:
        pass
    new_id = str(uuid.uuid4())
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(_CLIENT_ID_FILE, "w", encoding="utf-8") as f:
            f.write(new_id)
    except OSError:
        pass
    return new_id


_instance_id = _get_or_create_client_id()

_registry: dict[str, dict] = {}  # peer_id -> {id, host, port, name, ...}
_registry_lock = threading.Lock()
_started = False

_state_provider = None             # () -> (profile_name, power_share_enabled, logged_in)
_online_signaling_provider = None  # () -> (enabled, url)

_ws = None  # the live websocket connection, if any — guarded by _ws_lock
_ws_lock = threading.Lock()

_pending_calls: dict[str, dict] = {}  # request_id -> {"event": Event, "result": dict|None}
_pending_lock = threading.Lock()

# Lets background threads here push WS events to the LOCAL frontend (e.g. the
# incoming consent popup, or "lending power" status) — this module has no
# asyncio loop of its own, so it needs the main one handed to it once at
# startup (see set_broadcast / main.py's lifespan).
_main_loop = None
_broadcast_fn = None


def set_state_provider(fn):
    global _state_provider
    _state_provider = fn


def set_online_signaling_provider(fn):
    global _online_signaling_provider
    _online_signaling_provider = fn


def set_broadcast(loop, broadcast_fn):
    global _main_loop, _broadcast_fn
    _main_loop = loop
    _broadcast_fn = broadcast_fn


def broadcast_local(message: dict):
    """Pushes straight to THIS machine's own frontend over its local /ws —
    used by power_share_service's requester-side code to dismiss the
    'Вам допомагає X' banner once its call_peer(...) round trip resolves,
    without reaching into this module's private _broadcast_fn/_main_loop."""
    if _broadcast_fn and _main_loop:
        asyncio.run_coroutine_threadsafe(_broadcast_fn(message), _main_loop)


def get_discovered_peers() -> list[dict]:
    now = time.time()
    with _registry_lock:
        return [
            info for info in _registry.values()
            if now - info["last_seen"] <= STALE_AFTER_SECONDS
        ]


def broadcast_force_update_request(from_name: str) -> int:
    """Admin action — nudges every currently-online peer to go check for an
    update, regardless of what version each one happens to be running (the
    admin may know a release is out that the auto-updater's own periodic
    check hasn't caught yet, or just wants everyone reminded). Fire-and-
    forget to every peer's own relay id, no reply expected — this is a
    notice, not a request/response call. Returns how many peers were sent it."""
    peers = get_discovered_peers()
    sent = 0
    for peer in peers:
        if send_relay(peer["id"], {"kind": "force_update_request", "from_name": from_name}):
            sent += 1
    return sent


def start(backend_port: int):
    global _started
    if _started:
        return
    _started = True
    gpu = get_gpu_info()
    threading.Thread(target=_online_signaling_loop, args=(backend_port, gpu), daemon=True).start()
    pss.power_logger.info("Discovery started id=%s (gpu=%s, %.1f GB)", _instance_id[:8], gpu["name"], gpu["vram_gb"])


# --- Transfer relay (plain HTTPS to the Worker's R2-backed /transfer/:id) ---

def get_https_base() -> "str | None":
    enabled, url = _online_signaling_provider() if _online_signaling_provider else (False, None)
    if not enabled or not url:
        return None
    return url.replace("wss://", "https://").replace("ws://", "http://").rstrip("/")


# Cloudflare's account-level request body size cap (100MB on Free/Pro plans,
# 200MB on Business) sits well under a separated WAV stem's real size
# (routinely 300-400MB+ for a full episode) — confirmed live 2026-07-23: a
# single-shot PUT of a ~376MB result failed outright with a 400 before ever
# reaching the Worker's own code. Anything at or above this threshold goes
# through R2's multipart upload API instead (see the /transfer/:id/multipart
# routes in cloudflare-signaling/src/index.ts) — several smaller PUTs, each
# safely under the cap, rather than one giant one. Deliberately well under
# the documented 100MB floor to leave headroom for HTTP overhead.
MULTIPART_THRESHOLD = 80 * 1024 * 1024
MULTIPART_PART_SIZE = 80 * 1024 * 1024


def upload_transfer(transfer_id: str, stream, size: int) -> None:
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")

    if size < MULTIPART_THRESHOLD:
        resp = requests.put(
            f"{base}/transfer/{transfer_id}", data=stream,
            headers={"Content-Length": str(size)}, timeout=3600,
        )
        resp.raise_for_status()
        return

    create_resp = requests.post(f"{base}/transfer/{transfer_id}/multipart", timeout=30)
    create_resp.raise_for_status()
    upload_id = create_resp.json()["uploadId"]

    try:
        parts = []
        part_number = 1
        while True:
            chunk = stream.read(MULTIPART_PART_SIZE)
            if not chunk:
                break
            part_resp = requests.put(
                f"{base}/transfer/{transfer_id}/multipart/{upload_id}/{part_number}",
                data=chunk, headers={"Content-Length": str(len(chunk))}, timeout=3600,
            )
            part_resp.raise_for_status()
            part_info = part_resp.json()
            parts.append({"partNumber": part_info["partNumber"], "etag": part_info["etag"]})
            part_number += 1

        complete_resp = requests.post(
            f"{base}/transfer/{transfer_id}/multipart/{upload_id}/complete",
            json=parts, timeout=60,
        )
        complete_resp.raise_for_status()
    except Exception:
        try:
            requests.post(f"{base}/transfer/{transfer_id}/multipart/{upload_id}/abort", timeout=15)
        except Exception:
            pass
        raise


def download_transfer(transfer_id: str, dest_path: str) -> None:
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")
    resp = requests.get(f"{base}/transfer/{transfer_id}", stream=True, timeout=3600)
    resp.raise_for_status()
    with open(dest_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)


def delete_transfer(transfer_id: str) -> None:
    base = get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/transfer/{transfer_id}", timeout=15)
    except Exception:
        pass


# --- "Suggestions & complaints" inbox (plain HTTPS to the Worker's /feedback
# routes — see cloudflare-signaling/src/index.ts) ---

def submit_feedback(nickname: str, message: str) -> str:
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")
    resp = requests.post(f"{base}/feedback", json={"nickname": nickname, "message": message}, timeout=15)
    resp.raise_for_status()
    return resp.json()["id"]


def list_feedback() -> list[dict]:
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")
    resp = requests.get(f"{base}/feedback", timeout=15)
    resp.raise_for_status()
    return resp.json()


def delete_feedback(feedback_id: str) -> None:
    base = get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/feedback/{feedback_id}", timeout=15)
    except Exception:
        pass


# --- Separation-run reports for the admin (plain HTTPS to the Worker's
# /reports routes — see cloudflare-signaling/src/index.ts) ---

def submit_report(report: dict) -> "str | None":
    base = get_https_base()
    if not base:
        return None
    resp = requests.post(f"{base}/reports", json=report, timeout=15)
    resp.raise_for_status()
    return resp.json()["id"]


def list_reports() -> list[dict]:
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")
    resp = requests.get(f"{base}/reports", timeout=15)
    resp.raise_for_status()
    return resp.json()


def delete_report(report_id: str) -> None:
    base = get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/reports/{report_id}", timeout=15)
    except Exception:
        pass


# --- Апекс line-up sync (plain HTTPS to the Worker's /apex-models — see
# cloudflare-signaling/src/index.ts) ---

def push_apex_models(lineup: list[dict]) -> None:
    """Best-effort — called after the admin adds/removes a model locally
    (see routers/separation_models.py). Never raises: a failed push here
    would otherwise turn a successful local edit into a request error for
    no reason, and the next successful push (or the next puller's own read)
    reconciles things anyway."""
    base = get_https_base()
    if not base:
        return
    try:
        requests.put(f"{base}/apex-models", json=lineup, timeout=15)
    except Exception:
        pass


def submit_model_rating(rating: dict) -> None:
    """Best-effort — called right after a rating is saved locally (see
    routers/model_browser.py). Never raises, same reasoning as
    push_apex_models above: the local save already succeeded, and the next
    successful push (by this install or the rater re-rating later) or the
    next puller's own read reconciles things regardless. The Worker's
    /model-ratings PUT key is deterministic (method+filename+profile_name),
    so this naturally overwrites this profile's own prior rating for the
    same model rather than accumulating duplicates."""
    base = get_https_base()
    if not base:
        return
    try:
        requests.put(f"{base}/model-ratings", json=rating, timeout=15)
    except Exception:
        pass


def list_model_ratings() -> list[dict]:
    """Unlike list_feedback/list_reports, returns [] rather than raising when
    unreachable — the Model Browser should stay usable (showing whatever's
    cached locally) even with the Worker offline, not hard-fail the whole
    panel over a supplementary feature like ratings."""
    base = get_https_base()
    if not base:
        return []
    try:
        resp = requests.get(f"{base}/model-ratings", timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return []


# --- Model Browser catalog (models added via "add by URL", stored server-
# side in the Worker's D1 database rather than any per-install SQLite — see
# cloudflare-signaling/schema.sql and routers/model_browser.py) ---

def auto_configure_model(url: str) -> dict:
    """Asks the Worker's Workers-AI-backed /models/auto-configure to figure
    out method/arch/filename/download_url/config_yaml_url from a repository
    URL — raises on failure (unlike the best-effort functions below) because
    the caller needs to show the user a real error, not silently do nothing,
    when they've just pasted a link and are waiting for a result."""
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")
    resp = requests.post(f"{base}/models/auto-configure", json={"url": url}, timeout=45)
    resp.raise_for_status()
    return resp.json()


def add_browsable_model(item: dict) -> dict:
    base = get_https_base()
    if not base:
        raise ValueError("Онлайн-сигналізація не налаштована — вкажіть URL сервера у Налаштуваннях")
    resp = requests.post(f"{base}/models", json=item, timeout=15)
    resp.raise_for_status()
    return resp.json()


def list_browsable_models(method: "str | None" = None) -> list[dict]:
    """[] on any failure (offline, unconfigured, Worker down) — the browser
    should still show the local audio-separator registry even when the
    shared community catalog is unreachable, not hard-fail the whole panel."""
    base = get_https_base()
    if not base:
        return []
    try:
        params = {"method": method} if method else {}
        resp = requests.get(f"{base}/models", params=params, timeout=15)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return []


def get_browsable_model(model_id: str) -> "dict | None":
    base = get_https_base()
    if not base:
        return None
    try:
        resp = requests.get(f"{base}/models/{model_id}", timeout=15)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def delete_browsable_model(model_id: str) -> None:
    base = get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/models/{model_id}", timeout=15)
    except Exception:
        pass


def delete_model_ratings(method: str, filename: str) -> None:
    """Best-effort — called right after a catalog entry is removed (see
    routers/model_browser.py's delete_catalog_entry), since ratings are
    keyed by (method, filename) rather than the catalog row's own id and
    would otherwise silently outlive the model they were rating: re-adding
    the same file later would resurrect its old star ratings as if they'd
    never been deleted — confirmed live as a real report."""
    base = get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/model-ratings", params={"method": method, "filename": filename}, timeout=15)
    except Exception:
        pass


def pull_apex_models() -> "list[dict] | None":
    """None means "couldn't reach the Worker" (offline, not configured, or
    genuinely down) — distinct from an empty list, which means the Worker
    answered and no one has ever pushed a line-up yet. Callers use None to
    mean "keep whatever's local," not "the shared line-up is empty."""
    base = get_https_base()
    if not base:
        return None
    try:
        resp = requests.get(f"{base}/apex-models", timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


# --- Relay messaging (consent handshake + job control) ---

def send_relay(target_id: str, payload: dict) -> bool:
    with _ws_lock:
        if _ws is None:
            return False
        try:
            _ws.send(json.dumps({"type": "relay", "target_id": target_id, "payload": payload}))
            return True
        except Exception:
            return False


# Only these three — never an arbitrary client-supplied path — are exposed
# to a peer's "view logs" admin feature (see _handle_log_fetch_request).
LOG_FILENAMES = ["app.log", "power_share.log", "electron.log"]
LOG_TAIL_BYTES = 200_000


def fetch_peer_log(peer_id: str, filename: str) -> str:
    """Requester side of the admin log viewer — blocks for the peer's reply,
    same call_peer round trip every other power-share feature uses."""
    if filename not in LOG_FILENAMES:
        raise ValueError(f"Невідомий файл журналу: {filename}")
    result = call_peer(peer_id, {"kind": "log_fetch_request", "filename": filename}, timeout=20)
    if result.get("error"):
        raise ValueError(result["error"])
    return result.get("content", "")


def _handle_log_fetch_request(from_id: str, payload: dict):
    """Runs on the machine WHOSE logs are being viewed — reads a bounded tail
    (not the whole file — electron.log has no rotation cap, and even the
    rotated Python logs can be a few MB across their backups) straight off
    disk and relays it back. Read-only by construction: there is no matching
    'write'/'edit' relay kind anywhere in this module."""
    filename = payload.get("filename", "")
    request_id = payload.get("request_id", "")
    if filename not in LOG_FILENAMES:
        send_relay(from_id, {"kind": "log_fetch_response", "request_id": request_id, "error": "Невідомий файл журналу"})
        return
    path = os.path.join(pss.LOG_DIR, filename)
    try:
        if not os.path.isfile(path):
            content = ""
        else:
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                if size > LOG_TAIL_BYTES:
                    f.seek(size - LOG_TAIL_BYTES)
                content = f.read().decode("utf-8", errors="replace")
        send_relay(from_id, {"kind": "log_fetch_response", "request_id": request_id, "content": content})
    except Exception as exc:
        send_relay(from_id, {"kind": "log_fetch_response", "request_id": request_id, "error": str(exc)})


def call_peer(target_id: str, payload: dict, timeout: float = RELAY_CALL_DEFAULT_TIMEOUT, context: "dict | None" = None) -> dict:
    """Sends a relay message carrying its own request_id and blocks until the
    matching reply relay message arrives (or times out) — the requester
    side of both the consent handshake and job dispatch.

    `context` is stashed alongside the pending entry (NOT sent over the
    wire) purely so an intermediate, non-resolving relay message for this
    same request_id — a `job_progress` tick, see _handle_job_progress below
    — can look up who/what this call was for (peer name, task, title) without
    a second round trip. Progress ticks never pop/resolve this entry; only
    job_done/job_error/consent_response do (see _resolve_call)."""
    request_id = payload.setdefault("request_id", str(uuid.uuid4()))
    event = threading.Event()
    with _pending_lock:
        _pending_calls[request_id] = {"event": event, "result": None, "context": context or {}}
    if not send_relay(target_id, payload):
        with _pending_lock:
            _pending_calls.pop(request_id, None)
        raise ConnectionError("Онлайн-сигналізація не підключена")
    answered = event.wait(timeout=timeout)
    with _pending_lock:
        entry = _pending_calls.pop(request_id, {"result": None})
    if not answered:
        raise TimeoutError("Пір не відповів вчасно")
    return entry["result"]


def _resolve_call(request_id: str, result: dict):
    with _pending_lock:
        entry = _pending_calls.get(request_id)
        if entry:
            entry["result"] = result
            entry["event"].set()


def _handle_job_progress(payload: dict):
    """Runs on the REQUESTER machine — a live percent tick relayed from the
    peer actually doing the work (see power_share_service's _broadcast_lending
    closures, which now relay every tick here in addition to updating the
    peer's own 'lending' banner). Mirrors that banner on the requester's side
    ('Вам допомагає X…') so the person who ASKED for power sees the same live
    progress the person LENDING it does, not just a blind wait — pulls peer
    name/task/title back out of the pending call's stashed context rather
    than resending all of it on every tick."""
    request_id = payload.get("request_id", "")
    with _pending_lock:
        entry = _pending_calls.get(request_id)
        ctx = dict(entry["context"]) if entry and entry.get("context") else None
    if not ctx or not _broadcast_fn or not _main_loop:
        return
    asyncio.run_coroutine_threadsafe(
        _broadcast_fn({
            "type": "power_share_borrowing",
            "data": {
                "active": True,
                "task": ctx.get("task"),
                "peer_name": ctx.get("peer_name"),
                "title_name": ctx.get("title_name"),
                "episode_number": ctx.get("episode_number"),
                "percent": payload.get("percent"),
                "message": payload.get("message"),
            },
        }),
        _main_loop,
    )


def _handle_relay(from_id: str, payload: dict):
    kind = payload.get("kind")

    if kind == "consent_request":
        threading.Thread(target=_handle_consent_request, args=(from_id, payload), daemon=True).start()
        return

    if kind in ("consent_response", "job_done", "job_error"):
        _resolve_call(payload.get("request_id", ""), payload)
        return

    if kind == "job_progress":
        _handle_job_progress(payload)
        return

    if kind == "job_request":
        threading.Thread(target=_handle_job_request, args=(from_id, payload), daemon=True).start()
        return

    if kind == "log_fetch_request":
        threading.Thread(target=_handle_log_fetch_request, args=(from_id, payload), daemon=True).start()
        return

    if kind == "log_fetch_response":
        _resolve_call(payload.get("request_id", ""), payload)
        return

    if kind == "force_update_request":
        broadcast_local({"type": "force_update_request", "data": {"from_name": payload.get("from_name", "Адмін")}})
        return


def _handle_consent_request(from_id: str, payload: dict):
    """Runs on the machine being ASKED for power — pops the local Так/Ні
    popup (via handle_incoming_consent_request, unchanged) and relays the
    decision back to the requester through the Worker."""
    body = {
        "requester_name": payload.get("requester_name", "?"),
        "requester_host": from_id,
        "title_id": payload.get("title_id"),
        "title_name": payload.get("title_name", "?"),
        "episode_number": payload.get("episode_number", 0),
        "task": payload.get("task", "separate"),
    }
    approved, reason = pss.handle_incoming_consent_request(body, broadcast_fn=_broadcast_fn, loop=_main_loop)
    send_relay(from_id, {
        "kind": "consent_response",
        "request_id": payload.get("request_id", ""),
        "approved": approved,
        "reason": reason,
    })


def _handle_job_request(from_id: str, payload: dict):
    """Runs on the RESPONDER machine — downloads the job's input from R2,
    runs it locally, uploads the result back to R2, and relays completion."""
    request_id = payload.get("request_id", "")
    task = payload.get("task", "separate")
    transfer_id = payload.get("transfer_id")
    filename = payload.get("filename") or "input"
    requester_name = payload.get("requester_name", "?")
    title_name = payload.get("title_name", "?")
    episode_number = payload.get("episode_number", 0)

    tmp_dir = tempfile.mkdtemp(prefix="rh_power_recv_")
    try:
        input_path = os.path.join(tmp_dir, filename)
        pss.power_logger.info("JOB-REQUEST-RECEIVED from=%s task=%s transfer=%s", from_id, task, transfer_id)
        download_transfer(transfer_id, input_path)
        delete_transfer(transfer_id)

        work_dir = None
        if task == "separate":
            pss.ensure_model_for_peer_job(
                payload.get("model", "MDX-Net"), payload.get("model_file"),
                requester_name, title_name, episode_number,
                broadcast_fn=_broadcast_fn, loop=_main_loop,
            )
            result_path, meta, work_dir = pss.run_separation_job_for_peer(
                input_path, payload.get("model", "MDX-Net"), bool(payload.get("ensemble")),
                requester_name, title_name, episode_number,
                model_file=payload.get("model_file"), params=payload.get("params"),
                broadcast_fn=_broadcast_fn, loop=_main_loop,
                relay_to=from_id, relay_request_id=request_id,
            )
        elif task == "render":
            # Final render needs a SECOND input (the instrumental, sent as
            # FLAC — see power_share_service.request_remote_render) on top of
            # the video every other task already downloads as `input_path`.
            audio_filename = payload.get("audio_filename") or "instrumental.flac"
            audio_transfer_id = payload.get("audio_transfer_id")
            audio_path = os.path.join(tmp_dir, audio_filename)
            download_transfer(audio_transfer_id, audio_path)
            delete_transfer(audio_transfer_id)
            result_path, meta, work_dir = pss.run_render_job_for_peer(
                input_path, audio_path, requester_name, title_name, episode_number,
                broadcast_fn=_broadcast_fn, loop=_main_loop,
                relay_to=from_id, relay_request_id=request_id,
            )
        else:
            result_path, meta, work_dir = pss.run_import_job_for_peer(
                input_path, requester_name, title_name, episode_number,
                broadcast_fn=_broadcast_fn, loop=_main_loop,
                relay_to=from_id, relay_request_id=request_id,
            )

        # Some tasks carry back a SECOND file alongside the primary result —
        # "separate" sends the pure-vocal stem (meta["vocal_only_path"],
        # needed by detect-markers on the requester's side, see
        # power_share_service.run_separation_job_for_peer), "render" sends
        # the standalone FLAC audio (meta["audio_output_path"], see
        # run_mux_ffmpeg_only / run_render_job_for_peer). The existing
        # protocol only ever moves one file per job, so this rides alongside
        # as a second, separate transfer rather than replacing it.
        _EXTRA_FILE_KEY_BY_TASK = {"separate": "vocal_only_path", "render": "audio_output_path"}

        try:
            result_transfer_id = str(uuid.uuid4())
            result_size = os.path.getsize(result_path)
            with open(result_path, "rb") as f:
                upload_transfer(result_transfer_id, f, result_size)

            extra_transfer_id = None
            extra_key = _EXTRA_FILE_KEY_BY_TASK.get(task)
            extra_path = meta.pop(extra_key, None) if (extra_key and isinstance(meta, dict)) else None
            if extra_path and os.path.isfile(extra_path):
                extra_transfer_id = str(uuid.uuid4())
                extra_size = os.path.getsize(extra_path)
                with open(extra_path, "rb") as f:
                    upload_transfer(extra_transfer_id, f, extra_size)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

        pss.power_logger.info(
            "JOB-REQUEST-DONE from=%s task=%s result_transfer=%s extra_transfer=%s",
            from_id, task, result_transfer_id, extra_transfer_id,
        )
        send_relay(from_id, {
            "kind": "job_done", "request_id": request_id,
            "result_transfer_id": result_transfer_id,
            "vocal_only_transfer_id": extra_transfer_id if task == "separate" else None,
            "audio_output_transfer_id": extra_transfer_id if task == "render" else None,
            "meta": meta,
        })
    except Exception as exc:
        pss.power_logger.exception("JOB-REQUEST-ERROR from=%s task=%s", from_id, task)
        send_relay(from_id, {"kind": "job_error", "request_id": request_id, "reason": str(exc)})
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# --- The persistent signaling connection ---

def _online_signaling_loop(backend_port: int, gpu: dict):
    """Keeps one persistent WebSocket open to the signaling Worker (if
    configured), re-sending "hello" on a short interval — both a keepalive
    and what makes the Worker rebroadcast the full peer list on a schedule,
    since without SOME periodic refresh, an online peer with nothing new to
    report would never touch every other client's `last_seen` for it and
    would incorrectly age out via STALE_AFTER_SECONDS despite still being
    connected. Also the sole transport for relay (consent + job control)
    messages. Runs forever in its own thread; reconnects on any drop."""
    global _ws
    own_id: "str | None" = None
    while True:
        enabled, url = _online_signaling_provider() if _online_signaling_provider else (False, None)
        if not enabled or not url:
            _prune_registry()
            time.sleep(ONLINE_SIGNALING_RECONNECT_SECONDS)
            continue

        try:
            with ws_connect(url, open_timeout=10) as ws:
                with _ws_lock:
                    _ws = ws
                pss.power_logger.info("Online signaling connected url=%s", url)

                def send_hello():
                    name, power_share_enabled, logged_in = (
                        _state_provider() if _state_provider else ("?", False, False)
                    )
                    ws.send(json.dumps({
                        "type": "hello",
                        "client_id": _instance_id,
                        "port": backend_port,
                        "name": name,
                        "power_share_enabled": power_share_enabled,
                        "logged_in": logged_in,
                        "gpu_name": gpu["name"],
                        "vram_gb": gpu["vram_gb"],
                    }))

                send_hello()
                last_heartbeat = time.monotonic()
                while True:
                    if time.monotonic() - last_heartbeat >= ONLINE_SIGNALING_HEARTBEAT_SECONDS:
                        send_hello()
                        last_heartbeat = time.monotonic()
                    try:
                        raw = ws.recv(timeout=ONLINE_SIGNALING_HEARTBEAT_SECONDS)
                    except TimeoutError:
                        continue
                    msg = json.loads(raw)

                    if msg.get("type") == "welcome":
                        own_id = msg.get("your_id")
                        continue

                    if msg.get("type") == "peers":
                        now = time.time()
                        with _registry_lock:
                            for peer in msg.get("peers", []):
                                if peer.get("id") == own_id:
                                    continue
                                _registry[peer["id"]] = {
                                    "id": peer["id"],
                                    "host": peer["host"],
                                    "port": peer["port"],
                                    "name": peer.get("name", "?"),
                                    "power_share_enabled": bool(peer.get("power_share_enabled")),
                                    "logged_in": bool(peer.get("logged_in")),
                                    "gpu_name": peer.get("gpu_name", "Невідома відеокарта"),
                                    "vram_gb": peer.get("vram_gb", 0.0),
                                    "last_seen": now,
                                }
                            # A peer not in THIS broadcast means it
                            # disconnected — drop it immediately rather than
                            # waiting out STALE_AFTER_SECONDS.
                            current_ids = {p["id"] for p in msg.get("peers", []) if p.get("id") != own_id}
                            for key in [k for k in _registry if k not in current_ids]:
                                del _registry[key]
                        continue

                    if msg.get("type") == "relay":
                        _handle_relay(msg.get("from_id", ""), msg.get("payload", {}) or {})
                        continue
        except (WebSocketException, OSError, TimeoutError) as exc:
            pss.power_logger.info("Online signaling disconnected url=%s error=%s", url, exc)
        except Exception:
            pss.power_logger.exception("Online signaling loop crashed unexpectedly")
        finally:
            with _ws_lock:
                _ws = None
            _prune_registry()

        time.sleep(ONLINE_SIGNALING_RECONNECT_SECONDS)


def _prune_registry():
    with _registry_lock:
        _registry.clear()
