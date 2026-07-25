"""
Distributed power-sharing: lets a weak-PC user borrow a strong-PC peer's compute
to run vocal separation or a full remote import, with explicit per-request
consent — entirely over the internet through the Cloudflare signaling Worker
(see discovery_service.py / cloudflare-signaling/), never a direct connection
between the two PCs.

Flow:
  1. Requester's backend broadcasts a consent-request (relayed through the
     Worker) to every configured peer that hasn't already approved this same
     title (in parallel).
  2. Each peer's backend (if power-sharing is enabled there) pushes a WS
     notification to its own frontend and blocks up to 60s waiting for a
     Так/Ні click, unless that peer+title was already approved before.
  3. First peer to approve gets the input file uploaded to the Worker's R2
     bucket, downloads it there, runs the job locally on its own machine,
     uploads the result back to R2, and the requester downloads it from
     there.
  4. Everything is logged to power_share.log (and mirrored into app.log).

Off by default (AppSettings.power_share_enabled) — a peer never receives an
actionable consent-request unless this machine has explicitly turned it on.
"""
import asyncio
import os
import shutil
import tempfile
import threading
import uuid
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

from sqlalchemy.orm import Session

from ..models import PowerShareConsent, AppSettings, Episode, Title, Profile
from ..database import SessionLocal
from .title_status import bump_title_in_progress

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
LOG_DIR = os.path.join(DATA_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

CONSENT_TIMEOUT_SECONDS = 60


def _make_logger(name: str, own_filename: str, also_write_to: Optional[str] = None) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    if not logger.handlers:
        fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
        h1 = RotatingFileHandler(os.path.join(LOG_DIR, own_filename), maxBytes=2_000_000, backupCount=3, encoding="utf-8")
        h1.setFormatter(fmt)
        logger.addHandler(h1)
        if also_write_to:
            h2 = RotatingFileHandler(os.path.join(LOG_DIR, also_write_to), maxBytes=2_000_000, backupCount=3, encoding="utf-8")
            h2.setFormatter(fmt)
            logger.addHandler(h2)
    return logger


app_logger = _make_logger("raccoonhouse", "app.log")
power_logger = _make_logger("power_share", "power_share.log", also_write_to="app.log")


# --- Responder side: pending consent requests awaiting a local Так/Ні click ---
_pending: dict[str, dict] = {}
_pending_lock = threading.Lock()


def handle_incoming_consent_request(body: dict, broadcast_fn=None, loop=None) -> tuple[bool, str]:
    """Runs on the machine being ASKED for power. Returns (approved, reason)."""
    db: Session = SessionLocal()
    try:
        settings = db.get(AppSettings, 1)
        if not settings or not settings.power_share_enabled:
            power_logger.info(
                "DENY (disabled) requester=%s title=%s", body["requester_host"], body["title_name"]
            )
            return False, "disabled"
        if not settings.active_profile_id:
            power_logger.info(
                "DENY (no active profile / not logged in) requester=%s title=%s",
                body["requester_host"], body["title_name"],
            )
            return False, "no_profile"

        if settings.power_share_auto_approve:
            power_logger.info(
                "AUTO-APPROVE (setting) requester=%s title=%s", body["requester_host"], body["title_name"]
            )
            return True, "auto_approved"

        existing = (
            db.query(PowerShareConsent)
            .filter(
                PowerShareConsent.peer_host == body["requester_host"],
                PowerShareConsent.title_id == body["title_id"],
                PowerShareConsent.granted == True,  # noqa: E712
            )
            .first()
        )
        if existing:
            power_logger.info(
                "AUTO-APPROVE (remembered) requester=%s title=%s", body["requester_host"], body["title_name"]
            )
            return True, "remembered"

        request_id = str(uuid.uuid4())
        event = threading.Event()
        with _pending_lock:
            _pending[request_id] = {"event": event, "approved": False}

        power_logger.info(
            "ASK requester=%s(%s) title=%s ep=%s task=%s request_id=%s",
            body["requester_name"], body["requester_host"], body["title_name"], body["episode_number"],
            body.get("task", "separate"), request_id,
        )

        if broadcast_fn and loop:
            asyncio.run_coroutine_threadsafe(
                broadcast_fn({
                    "type": "power_share_request",
                    "data": {
                        "request_id": request_id,
                        "requester_name": body["requester_name"],
                        "title_name": body["title_name"],
                        "episode_number": body["episode_number"],
                        "task": body.get("task", "separate"),
                        "timeout_seconds": CONSENT_TIMEOUT_SECONDS,
                    },
                }),
                loop,
            )

        answered = event.wait(timeout=CONSENT_TIMEOUT_SECONDS)
        with _pending_lock:
            entry = _pending.pop(request_id, {"approved": False})

        if not answered:
            power_logger.info("TIMEOUT request_id=%s", request_id)
            return False, "timeout"

        approved = entry["approved"]
        power_logger.info("%s request_id=%s", "APPROVE" if approved else "DENY", request_id)

        if approved:
            db.add(PowerShareConsent(peer_host=body["requester_host"], title_id=body["title_id"], granted=True))
            db.commit()

        return approved, ("approved" if approved else "denied")
    finally:
        db.close()


def respond_to_request(request_id: str, approved: bool) -> bool:
    """Called when the local user clicks Так/Ні on the incoming consent popup."""
    with _pending_lock:
        entry = _pending.get(request_id)
        if not entry:
            return False
        entry["approved"] = approved
        entry["event"].set()
    return True


# --- Responder side: actually running a dispatched job locally ---

def run_separation_job_for_peer(
    input_path: str, model: str, ensemble: bool,
    requester_name: str, title_name: str, episode_number: int,
    model_file: Optional[str] = None, params: Optional[dict] = None, broadcast_fn=None, loop=None,
) -> tuple[str, dict, str]:
    """Runs on the RESPONDER machine — separates someone else's (already
    downloaded) audio file locally. Returns (vocal_stem_path, meta, tmp_dir);
    the caller uploads vocal_stem_path to the transfer relay, then removes
    tmp_dir. Broadcasts a WS status so THIS machine's own UI shows "lending
    power" the whole time — otherwise the person whose PC is doing the work
    would have zero visibility that it's happening at all."""
    from .separator_service import separate_file

    def _broadcast_lending(active: bool):
        if broadcast_fn and loop:
            asyncio.run_coroutine_threadsafe(
                broadcast_fn({
                    "type": "power_share_lending",
                    "data": {
                        "active": active, "task": "separate",
                        "requester_name": requester_name, "title_name": title_name,
                        "episode_number": episode_number,
                    },
                }),
                loop,
            )

    tmp_dir = tempfile.mkdtemp(prefix="rh_power_share_")
    power_logger.info("RUN-SEPARATION-RECEIVED requester=%s title=%s ep=%s model=%s", requester_name, title_name, episode_number, model)
    _broadcast_lending(True)
    try:
        output_dir = os.path.join(tmp_dir, "out")
        stems = separate_file(input_path, output_dir, model, ensemble, model_file=model_file, params=params)
        # Only the instrumental crosses the wire — the pure-vocal stem (VAD
        # marker detection input) stays local to whichever machine actually
        # runs detect-markers, which for a power-shared separation is the
        # requester, not this responder. A remotely separated episode simply
        # has no vocal_only_stem_path, same as any other episode that hasn't
        # had markers detected yet.
        final_vocal = stems["vocal_stem_path"]
        power_logger.info("RUN-SEPARATION-DONE final_vocal=%s", final_vocal)
        return final_vocal, {}, tmp_dir
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    finally:
        _broadcast_lending(False)


def run_import_job_for_peer(
    input_path: str, requester_name: str, title_name: str, episode_number: int,
    broadcast_fn=None, loop=None,
) -> tuple[str, dict, str]:
    """Runs on the RESPONDER machine — extracts audio locally from someone
    else's (already downloaded) ORIGINAL video file. Returns (audio_path,
    metadata, tmp_dir); meant for a requester whose own PC is too weak to
    comfortably run ffmpeg itself, so this step happens BEFORE any local
    processing on the requester's side."""
    from .ffmpeg_service import run_import_ffmpeg_only

    def _broadcast_lending(active: bool):
        if broadcast_fn and loop:
            asyncio.run_coroutine_threadsafe(
                broadcast_fn({
                    "type": "power_share_lending",
                    "data": {
                        "active": active, "task": "import",
                        "requester_name": requester_name, "title_name": title_name,
                        "episode_number": episode_number,
                    },
                }),
                loop,
            )

    tmp_dir = tempfile.mkdtemp(prefix="rh_power_import_")
    _broadcast_lending(True)
    try:
        out_dir = os.path.join(tmp_dir, "out")
        result = run_import_ffmpeg_only(input_path, out_dir)
        return result["audio_path"], result, tmp_dir
    except Exception:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    finally:
        _broadcast_lending(False)


# --- Requester side ---

def _active_profile_name(db: Session) -> str:
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id:
        profile = db.get(Profile, settings.active_profile_id)
        if profile:
            return profile.name
    return "Невідомий користувач"


def _ask_peer(peer: dict, task: str, extra: dict) -> tuple[dict, bool, str]:
    from . import discovery_service
    try:
        result = discovery_service.call_peer(
            peer["id"],
            {"kind": "consent_request", "task": task, **extra},
            timeout=CONSENT_TIMEOUT_SECONDS + 10,
        )
        return peer, bool(result.get("approved")), result.get("reason", "")
    except TimeoutError:
        return peer, False, "timeout"
    except Exception as exc:
        power_logger.info("UNREACHABLE peer=%s error=%s", peer["id"], exc)
        return peer, False, "unreachable"


_DENY_REASON_TEXT = {
    "disabled": "вимкнув розподілену обробку в налаштуваннях",
    "no_profile": "ніхто не залогінений на тому ПК (немає активного профілю)",
    "denied": "відхилив запит",
    "timeout": f"не відповів за {CONSENT_TIMEOUT_SECONDS} секунд",
    "unreachable": "не вдалося з'єднатися через сервер сигналізації (перевірте, чи він онлайн)",
}


def _deny_reason_text(reason: str) -> str:
    return _DENY_REASON_TEXT.get(reason, reason or "відмова")


def _acquire_peer(title_id: int, title_name: str, episode_number: int, task: str, reporter, db: Session) -> dict:
    """Shared negotiation step for BOTH power-share flows (vocal separation and
    full remote import): find an already-remembered peer for this title, or
    broadcast a consent-request to everyone available and wait for the first
    Так. Reports each stage through `reporter` (may be None) so the requesting
    UI always shows a specific, human-readable status instead of a bare
    'Обробка' — including WHY, per peer, if nobody agrees."""
    from . import discovery_service

    if reporter:
        reporter.update(5, "Шукаю доступні ПК через сервер сигналізації…")

    peers = [p for p in discovery_service.get_discovered_peers() if p["power_share_enabled"] and p["logged_in"]]
    if not peers:
        raise ValueError(
            "Немає жодного доступного ПК онлайн — переконайтесь, що на іншому ПК увімкнено "
            "розподілену обробку в Налаштуваннях, хтось там залогінений (обраний профіль), і сервер "
            "сигналізації налаштований на обох ПК"
        )

    remembered_ids = {
        c.peer_host for c in db.query(PowerShareConsent).filter(
            PowerShareConsent.title_id == title_id, PowerShareConsent.granted == True  # noqa: E712
        ).all()
    }

    for peer in peers:
        if peer["id"] in remembered_ids:
            power_logger.info("USE-REMEMBERED peer=%s title=%s", peer["id"], title_name)
            if reporter:
                reporter.update(15, f"{peer['name']} вже погоджувався для цього тайтлу — надсилаю без повторного питання…")
            return peer

    payload = {
        "requester_name": _active_profile_name(db),
        "title_id": title_id,
        "title_name": title_name,
        "episode_number": episode_number,
    }

    if reporter:
        names = ", ".join(p["name"] for p in peers)
        reporter.update(10, f"Надсилаю запит на дозвіл: {names} (очікую підтвердження, до {CONSENT_TIMEOUT_SECONDS}с)…")
    power_logger.info(
        "BROADCAST title=%s ep=%s task=%s peers=%s", title_name, episode_number, task, [p["id"] for p in peers]
    )

    chosen: Optional[dict] = None
    denials: list[str] = []
    pool = ThreadPoolExecutor(max_workers=max(1, len(peers)))
    try:
        futures = {pool.submit(_ask_peer, p, task, payload): p for p in peers}
        for future in as_completed(futures):
            peer, approved, reason = future.result()
            if approved:
                chosen = peer
                db.add(PowerShareConsent(peer_host=peer["id"], title_id=title_id, granted=True))
                db.commit()
                break  # first Так wins — don't wait on the rest (they may be
                       # slow, unreachable, or simply never get clicked)
            denials.append(f"{peer['name']} — {_deny_reason_text(reason)}")
    finally:
        # Plain shutdown(wait=True) (what a `with` block does on exit) would
        # block here until EVERY peer's up-to-70s _ask_peer call finishes —
        # even the ones we no longer care about once someone already said Так.
        pool.shutdown(wait=False, cancel_futures=True)

    if not chosen:
        power_logger.info("NO-PEER-APPROVED title=%s ep=%s task=%s", title_name, episode_number, task)
        detail = "; ".join(denials) if denials else "немає відповіді від жодного ПК"
        raise ValueError(f"Ніхто не погодився надати потужність. {detail}.")

    if reporter:
        reporter.update(20, f"{chosen['name']} погодився — готую передачу…")
    return chosen


class _ProgressFile:
    """Wraps a file for streaming upload via `requests`, reporting read
    progress as bytes are consumed — used for uploads to the transfer relay,
    where the file can be hundreds of MB to a few GB and a silent multi-
    minute upload would look identical to a frozen app."""

    def __init__(self, path: str, total_size: int, on_progress=None, pct_lo: int = 20, pct_hi: int = 80):
        self._f = open(path, "rb")
        self._total = max(1, total_size)
        self._sent = 0
        self._on_progress = on_progress
        self._pct_lo = pct_lo
        self._pct_hi = pct_hi

    def read(self, size: int = -1) -> bytes:
        chunk = self._f.read(size if size and size > 0 else 1024 * 1024)
        self._sent += len(chunk)
        if self._on_progress:
            frac = min(1.0, self._sent / self._total)
            pct = int(self._pct_lo + (self._pct_hi - self._pct_lo) * frac)
            self._on_progress(pct)
        return chunk

    def __len__(self) -> int:
        return self._total

    def close(self):
        self._f.close()


def request_remote_power(episode_id: int, model: str, ensemble: bool, reporter=None, model_file: Optional[str] = None, params: Optional[dict] = None) -> dict:
    """Requester side for vocal separation: negotiates a peer, uploads the
    already-extracted audio track to the transfer relay, and stores the
    returned vocal stem.

    Opens its own DB session rather than reusing the request's — this runs in
    a background thread pool that outlives the HTTP request, and a request-
    scoped Session gets closed by FastAPI's dependency teardown as soon as the
    endpoint returns, well before this (which can take minutes: consent wait +
    upload + remote processing) actually finishes. Reusing it intermittently
    raised "identity map is no longer valid" once real work happened between
    the two — confirmed via a live two-process end-to-end test."""
    db = SessionLocal()
    try:
        return _request_remote_power(episode_id, model, ensemble, db, reporter, model_file, params)
    finally:
        db.close()


def _request_remote_power(episode_id: int, model: str, ensemble: bool, db: Session, reporter=None, model_file: Optional[str] = None, params: Optional[dict] = None) -> dict:
    from . import discovery_service

    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError("Episode not found")
    title = db.get(Title, ep.title_id)
    if not title:
        raise ValueError("Title not found")
    if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
        raise ValueError("Аудіодоріжка не знайдена — спершу імпортуйте відео")

    chosen = _acquire_peer(title.id, title.name_ua, ep.number, "separate", reporter, db)

    file_size = os.path.getsize(ep.audio_stem_path)
    transfer_id = str(uuid.uuid4())

    def on_upload_progress(pct):
        if reporter:
            reporter.update(pct, f"Надсилаю аудіо на {chosen['name']}…")

    stream = _ProgressFile(ep.audio_stem_path, file_size, on_upload_progress, pct_lo=20, pct_hi=45)
    try:
        power_logger.info("DISPATCH peer=%s title=%s ep=%s", chosen["id"], title.name_ua, ep.number)
        discovery_service.upload_transfer(transfer_id, stream, file_size)
    finally:
        stream.close()

    if reporter:
        reporter.update(46, f"{chosen['name']} обробляє…")

    result = discovery_service.call_peer(chosen["id"], {
        "kind": "job_request",
        "task": "separate",
        "transfer_id": transfer_id,
        "filename": os.path.basename(ep.audio_stem_path),
        "model": model,
        "ensemble": bool(ensemble),
        "model_file": model_file,
        "params": params,
        "requester_name": _active_profile_name(db),
        "title_name": title.name_ua,
        "episode_number": ep.number,
    }, timeout=3600)
    power_logger.info("DISPATCH-RESPONSE peer=%s result=%s", chosen["id"], result.get("kind", "job_done"))

    if result.get("kind") == "job_error" or not result.get("result_transfer_id"):
        raise ValueError(f"Помилка на {chosen['name']}: {result.get('reason', 'невідома помилка')}")

    if reporter:
        reporter.update(90, "Зберігаю отриманий вокальний стем…")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    output_dir = ep_dir / "stems"
    output_dir.mkdir(parents=True, exist_ok=True)
    final_vocal = str(output_dir / "vocal_isolated.wav")
    discovery_service.download_transfer(result["result_transfer_id"], final_vocal)
    discovery_service.delete_transfer(result["result_transfer_id"])

    ep.vocal_stem_path = final_vocal
    ep.status = "vocal_isolated"
    bump_title_in_progress(db, ep.title_id)
    db.commit()

    power_logger.info("DONE peer=%s title=%s ep=%s", chosen["id"], title.name_ua, ep.number)
    if reporter:
        reporter.update(100, f"Готово — вокал відокремлено на {chosen['name']}")
    return {"vocal_stem_path": final_vocal, "peer": chosen["name"]}


def request_remote_import(episode_id: int, file_path: str, reporter=None) -> dict:
    """Requester side for a full remote import: negotiates a peer, uploads the
    ORIGINAL video file (before any local ffmpeg work happens at all — meant
    for a PC too weak to comfortably run ffmpeg itself) to the transfer
    relay, and stores back the extracted audio track the peer produced.

    Opens its own DB session — see request_remote_power's docstring for why."""
    db = SessionLocal()
    try:
        return _request_remote_import(episode_id, file_path, db, reporter)
    finally:
        db.close()


def _request_remote_import(episode_id: int, file_path: str, db: Session, reporter=None) -> dict:
    from . import discovery_service

    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError("Episode not found")
    title = db.get(Title, ep.title_id)
    if not title:
        raise ValueError("Title not found")
    if not os.path.isfile(file_path):
        raise ValueError(f"Файл не знайдено: {file_path}")

    chosen = _acquire_peer(title.id, title.name_ua, ep.number, "import", reporter, db)

    file_size = os.path.getsize(file_path)
    filename = os.path.basename(file_path)
    transfer_id = str(uuid.uuid4())

    def on_upload_progress(pct):
        if reporter:
            reporter.update(pct, f"Завантажую відео на {chosen['name']} (ffmpeg виконається там)…")

    stream = _ProgressFile(file_path, file_size, on_upload_progress, pct_lo=20, pct_hi=75)
    try:
        power_logger.info("DISPATCH-IMPORT peer=%s title=%s ep=%s size=%s", chosen["id"], title.name_ua, ep.number, file_size)
        discovery_service.upload_transfer(transfer_id, stream, file_size)
    finally:
        stream.close()

    result = discovery_service.call_peer(chosen["id"], {
        "kind": "job_request",
        "task": "import",
        "transfer_id": transfer_id,
        "filename": filename,
        "requester_name": _active_profile_name(db),
        "title_name": title.name_ua,
        "episode_number": ep.number,
    }, timeout=3600)

    if result.get("kind") == "job_error" or not result.get("result_transfer_id"):
        raise ValueError(f"Помилка на {chosen['name']}: {result.get('reason', 'невідома помилка')}")

    if reporter:
        reporter.update(85, f"{chosen['name']} завершив ffmpeg — зберігаю результат…")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    ep_dir.mkdir(parents=True, exist_ok=True)
    audio_out = str(ep_dir / "audio_full.flac")
    discovery_service.download_transfer(result["result_transfer_id"], audio_out)
    discovery_service.delete_transfer(result["result_transfer_id"])

    meta = result.get("meta") or {}
    duration = meta.get("duration")
    bit_rate = meta.get("bit_rate")

    ep.original_file_path = file_path
    ep.audio_stem_path = audio_out
    ep.original_size = int(meta.get("file_size") or file_size)
    ep.original_bitrate = int(bit_rate) if bit_rate else None
    ep.original_format = meta.get("format_name") or None
    ep.duration = float(duration) if duration else None
    ep.status = "processing"
    db.commit()

    power_logger.info("DONE-IMPORT peer=%s title=%s ep=%s", chosen["id"], title.name_ua, ep.number)
    if reporter:
        reporter.update(100, f"Готово — аудіо отримано з {chosen['name']}")
    return {"audio_path": audio_out, "peer": chosen["name"]}
