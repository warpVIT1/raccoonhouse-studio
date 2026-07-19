"""
Distributed power-sharing: lets a weak-PC user borrow a strong-PC peer's compute
to run vocal separation, over the local network, with explicit per-request consent.

Flow:
  1. Requester's backend broadcasts a consent-request to every configured peer
     that hasn't already approved this same title (in parallel).
  2. Each peer's backend (if power-sharing is enabled there) pushes a WS
     notification to its own frontend and blocks up to 60s waiting for a
     Так/Ні click, unless that peer+title was already approved before.
  3. First peer to approve gets the extracted audio uploaded to it, runs the
     separation locally on its own machine, and returns the finished stem.
  4. Everything is logged to power_share.log (and mirrored into app.log).

Off by default (AppSettings.power_share_enabled) — a peer never receives an
actionable consent-request unless this machine has explicitly turned it on.
"""
import os
import socket
import threading
import uuid
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

import requests
from sqlalchemy.orm import Session

from ..models import PowerShareConsent, AppSettings, Episode, Title, Profile
from ..database import SessionLocal

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
LOG_DIR = os.path.join(DATA_DIR, "logs")
os.makedirs(LOG_DIR, exist_ok=True)

CONSENT_TIMEOUT_SECONDS = 60
BACKEND_PORT = 8765  # fixed across the app (see electron/main.ts)


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


def get_own_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


def peer_base_url(host: str, port: int) -> str:
    """Builds the base URL to reach a peer. `host` is normally a bare IP (LAN
    peer, or a router port-forward), giving http://host:port — but it may also
    be a full tunnel URL a user pastes in directly, e.g. an ngrok HTTP tunnel
    (`https://xxxx.ngrok-free.app`, HTTPS-only, no separate port to enter). An
    ngrok *TCP* tunnel (`ngrok tcp 8765`) instead gives a bare host:port pair
    like other tunnels/port-forwards, so it already works via the plain case."""
    if host.startswith("http://") or host.startswith("https://"):
        return host.rstrip("/")
    return f"http://{host}:{port}"


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
            import asyncio
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


# --- Requester side ---

def _active_profile_name(db: Session) -> str:
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id:
        profile = db.get(Profile, settings.active_profile_id)
        if profile:
            return profile.name
    return "Невідомий користувач"


def _ask_peer(peer: dict, payload: dict) -> tuple[dict, bool, str]:
    try:
        resp = requests.post(
            f"{peer_base_url(peer['host'], peer['port'])}/api/power-share/consent-request",
            json=payload,
            timeout=CONSENT_TIMEOUT_SECONDS + 10,
        )
        resp.raise_for_status()
        data = resp.json()
        return peer, bool(data.get("approved")), data.get("reason", "")
    except Exception as exc:
        power_logger.info("UNREACHABLE peer=%s:%s error=%s", peer["host"], peer["port"], exc)
        return peer, False, "unreachable"


_DENY_REASON_TEXT = {
    "disabled": "вимкнув розподілену обробку в налаштуваннях",
    "no_profile": "ніхто не залогінений на тому ПК (немає активного профілю)",
    "denied": "відхилив запит",
    "timeout": f"не відповів за {CONSENT_TIMEOUT_SECONDS} секунд",
    "unreachable": "не вдалося з'єднатися (перевірте мережу/фаєрвол)",
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
        reporter.update(5, "Шукаю доступні ПК у мережі…")

    peers = [p for p in discovery_service.get_discovered_peers() if p["power_share_enabled"] and p["logged_in"]]
    if not peers:
        raise ValueError(
            "Немає жодного доступного ПК на мережі — переконайтесь, що на іншому ПК увімкнено "
            "розподілену обробку в Налаштуваннях і хтось там залогінений (обраний профіль)"
        )

    remembered_hosts = {
        c.peer_host for c in db.query(PowerShareConsent).filter(
            PowerShareConsent.title_id == title_id, PowerShareConsent.granted == True  # noqa: E712
        ).all()
    }

    for peer in peers:
        if peer["host"] in remembered_hosts:
            power_logger.info("USE-REMEMBERED peer=%s title=%s", peer["host"], title_name)
            if reporter:
                reporter.update(15, f"{peer['name']} вже погоджувався для цього тайтлу — надсилаю без повторного питання…")
            return peer

    payload = {
        "requester_name": _active_profile_name(db),
        "requester_host": get_own_ip(),
        "requester_port": BACKEND_PORT,
        "title_id": title_id,
        "title_name": title_name,
        "episode_number": episode_number,
        "task": task,
    }

    if reporter:
        names = ", ".join(p["name"] for p in peers)
        reporter.update(10, f"Надсилаю запит на дозвіл: {names} (очікую підтвердження, до {CONSENT_TIMEOUT_SECONDS}с)…")
    power_logger.info(
        "BROADCAST title=%s ep=%s task=%s peers=%s", title_name, episode_number, task, [p["host"] for p in peers]
    )

    chosen: Optional[dict] = None
    denials: list[str] = []
    pool = ThreadPoolExecutor(max_workers=max(1, len(peers)))
    try:
        futures = {pool.submit(_ask_peer, p, payload): p for p in peers}
        for future in as_completed(futures):
            peer, approved, reason = future.result()
            if approved:
                chosen = peer
                db.add(PowerShareConsent(peer_host=peer["host"], title_id=title_id, granted=True))
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
    progress as bytes are consumed — used for the full-video upload in
    request_remote_import, where the file can be hundreds of MB to a few GB
    and a silent multi-minute upload would look identical to a frozen app."""

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


def request_remote_power(episode_id: int, model: str, ensemble: bool, reporter=None) -> dict:
    """Requester side for vocal separation: negotiates a peer, uploads the
    already-extracted audio track, and stores the returned vocal stem.

    Opens its own DB session rather than reusing the request's — this runs in
    a background thread pool that outlives the HTTP request, and a request-
    scoped Session gets closed by FastAPI's dependency teardown as soon as the
    endpoint returns, well before this (which can take minutes: consent wait +
    upload + remote processing) actually finishes. Reusing it intermittently
    raised "identity map is no longer valid" once real work happened between
    the two — confirmed via a live two-process end-to-end test."""
    db = SessionLocal()
    try:
        return _request_remote_power(episode_id, model, ensemble, db, reporter)
    finally:
        db.close()


def _request_remote_power(episode_id: int, model: str, ensemble: bool, db: Session, reporter=None) -> dict:
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

    def on_upload_progress(pct):
        if reporter:
            reporter.update(pct, f"Надсилаю аудіо на {chosen['name']}…")

    stream = _ProgressFile(ep.audio_stem_path, file_size, on_upload_progress, pct_lo=20, pct_hi=45)
    try:
        power_logger.info("DISPATCH peer=%s title=%s ep=%s", chosen["host"], title.name_ua, ep.number)
        resp = requests.post(
            f"{peer_base_url(chosen['host'], chosen['port'])}/api/power-share/run-separation",
            files={"audio": (os.path.basename(ep.audio_stem_path), stream, "audio/flac")},
            data={
                "model": model,
                "ensemble": str(bool(ensemble)).lower(),
                "requester_name": _active_profile_name(db),
                "title_name": title.name_ua,
                "episode_number": ep.number,
            },
            timeout=3600,
        )
    finally:
        stream.close()
    power_logger.info("DISPATCH-RESPONSE peer=%s status=%s bytes=%s", chosen["host"], resp.status_code, len(resp.content))
    resp.raise_for_status()

    if reporter:
        reporter.update(90, "Зберігаю отриманий вокальний стем…")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    output_dir = ep_dir / "stems"
    output_dir.mkdir(parents=True, exist_ok=True)
    final_vocal = str(output_dir / "vocal_isolated.wav")
    with open(final_vocal, "wb") as out:
        out.write(resp.content)

    ep.vocal_stem_path = final_vocal
    ep.status = "vocal_isolated"
    db.commit()

    power_logger.info("DONE peer=%s title=%s ep=%s", chosen["host"], title.name_ua, ep.number)
    if reporter:
        reporter.update(100, f"Готово — вокал відокремлено на {chosen['name']}")
    return {"vocal_stem_path": final_vocal, "peer": chosen["name"]}


def request_remote_import(episode_id: int, file_path: str, reporter=None) -> dict:
    """Requester side for a full remote import: negotiates a peer, uploads the
    ORIGINAL video file (before any local ffmpeg work happens at all — meant
    for a PC too weak to comfortably run ffmpeg itself), and stores back the
    extracted audio track the peer produced.

    Opens its own DB session — see request_remote_power's docstring for why."""
    db = SessionLocal()
    try:
        return _request_remote_import(episode_id, file_path, db, reporter)
    finally:
        db.close()


def _request_remote_import(episode_id: int, file_path: str, db: Session, reporter=None) -> dict:
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

    def on_upload_progress(pct):
        if reporter:
            reporter.update(pct, f"Завантажую відео на {chosen['name']} (ffmpeg виконається там)…")

    stream = _ProgressFile(file_path, file_size, on_upload_progress, pct_lo=20, pct_hi=75)
    try:
        power_logger.info("DISPATCH-IMPORT peer=%s title=%s ep=%s size=%s", chosen["host"], title.name_ua, ep.number, file_size)
        resp = requests.post(
            f"{peer_base_url(chosen['host'], chosen['port'])}/api/power-share/run-import",
            params={
                "filename": filename,
                "requester_name": _active_profile_name(db),
                "title_name": title.name_ua,
                "episode_number": ep.number,
            },
            data=stream,
            headers={"Content-Type": "application/octet-stream"},
            timeout=3600,
        )
    finally:
        stream.close()
    resp.raise_for_status()

    if reporter:
        reporter.update(85, f"{chosen['name']} завершив ffmpeg — зберігаю результат…")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    ep_dir.mkdir(parents=True, exist_ok=True)
    audio_out = str(ep_dir / "audio_full.flac")
    with open(audio_out, "wb") as f:
        f.write(resp.content)

    duration_hdr = resp.headers.get("X-Duration", "0")
    bitrate_hdr = resp.headers.get("X-Bitrate", "0")

    ep.original_file_path = file_path
    ep.audio_stem_path = audio_out
    ep.original_size = int(resp.headers.get("X-File-Size", str(file_size)))
    ep.original_bitrate = int(bitrate_hdr) if bitrate_hdr.isdigit() and int(bitrate_hdr) > 0 else None
    ep.original_format = resp.headers.get("X-Format") or None
    ep.duration = float(duration_hdr) if _is_positive_float(duration_hdr) else None
    ep.status = "processing"
    db.commit()

    power_logger.info("DONE-IMPORT peer=%s title=%s ep=%s", chosen["host"], title.name_ua, ep.number)
    if reporter:
        reporter.update(100, f"Готово — аудіо отримано з {chosen['name']}")
    return {"audio_path": audio_out, "peer": chosen["name"]}


def _is_positive_float(s: str) -> bool:
    try:
        return float(s) > 0
    except (TypeError, ValueError):
        return False
