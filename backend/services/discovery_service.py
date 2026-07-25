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


def get_discovered_peers() -> list[dict]:
    now = time.time()
    with _registry_lock:
        return [
            info for info in _registry.values()
            if now - info["last_seen"] <= STALE_AFTER_SECONDS
        ]


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


def call_peer(target_id: str, payload: dict, timeout: float = RELAY_CALL_DEFAULT_TIMEOUT) -> dict:
    """Sends a relay message carrying its own request_id and blocks until the
    matching reply relay message arrives (or times out) — the requester
    side of both the consent handshake and job dispatch."""
    request_id = payload.setdefault("request_id", str(uuid.uuid4()))
    event = threading.Event()
    with _pending_lock:
        _pending_calls[request_id] = {"event": event, "result": None}
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


def _handle_relay(from_id: str, payload: dict):
    kind = payload.get("kind")

    if kind == "consent_request":
        threading.Thread(target=_handle_consent_request, args=(from_id, payload), daemon=True).start()
        return

    if kind in ("consent_response", "job_done", "job_error"):
        _resolve_call(payload.get("request_id", ""), payload)
        return

    if kind == "job_request":
        threading.Thread(target=_handle_job_request, args=(from_id, payload), daemon=True).start()
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
            result_path, meta, work_dir = pss.run_separation_job_for_peer(
                input_path, payload.get("model", "MDX-Net"), bool(payload.get("ensemble")),
                requester_name, title_name, episode_number,
                model_file=payload.get("model_file"), params=payload.get("params"),
                broadcast_fn=_broadcast_fn, loop=_main_loop,
            )
        else:
            result_path, meta, work_dir = pss.run_import_job_for_peer(
                input_path, requester_name, title_name, episode_number,
                broadcast_fn=_broadcast_fn, loop=_main_loop,
            )

        try:
            result_transfer_id = str(uuid.uuid4())
            result_size = os.path.getsize(result_path)
            with open(result_path, "rb") as f:
                upload_transfer(result_transfer_id, f, result_size)
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

        pss.power_logger.info("JOB-REQUEST-DONE from=%s task=%s result_transfer=%s", from_id, task, result_transfer_id)
        send_relay(from_id, {
            "kind": "job_done", "request_id": request_id,
            "result_transfer_id": result_transfer_id, "meta": meta,
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
