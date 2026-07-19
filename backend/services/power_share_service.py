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
            "ASK requester=%s(%s) title=%s ep=%s request_id=%s",
            body["requester_name"], body["requester_host"], body["title_name"], body["episode_number"], request_id,
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


def request_remote_power(episode_id: int, model: str, ensemble: bool, db: Session) -> dict:
    from . import discovery_service

    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError("Episode not found")
    title = db.get(Title, ep.title_id)
    if not title:
        raise ValueError("Title not found")
    if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
        raise ValueError("Audio stem not found — import video first")

    peers = [p for p in discovery_service.get_discovered_peers() if p["power_share_enabled"] and p["logged_in"]]
    if not peers:
        raise ValueError("Немає жодного доступного ПК на мережі — переконайтесь, що на іншому ПК увімкнено розподілену обробку і хтось залогінений")

    remembered_hosts = {
        c.peer_host for c in db.query(PowerShareConsent).filter(
            PowerShareConsent.title_id == title.id, PowerShareConsent.granted == True  # noqa: E712
        ).all()
    }

    chosen: Optional[dict] = None
    for peer in peers:
        if peer["host"] in remembered_hosts:
            chosen = peer
            power_logger.info("USE-REMEMBERED peer=%s title=%s", peer["host"], title.name_ua)
            break

    payload = {
        "requester_name": _active_profile_name(db),
        "requester_host": get_own_ip(),
        "requester_port": BACKEND_PORT,
        "title_id": title.id,
        "title_name": title.name_ua,
        "episode_number": ep.number,
    }

    if not chosen:
        to_ask = [p for p in peers if p["host"] not in remembered_hosts]
        power_logger.info(
            "BROADCAST title=%s ep=%s peers=%s", title.name_ua, ep.number, [p["host"] for p in to_ask]
        )
        with ThreadPoolExecutor(max_workers=max(1, len(to_ask))) as pool:
            futures = {pool.submit(_ask_peer, p, payload): p for p in to_ask}
            for future in as_completed(futures):
                peer, approved, reason = future.result()
                if approved:
                    chosen = peer
                    db.add(PowerShareConsent(peer_host=peer["host"], title_id=title.id, granted=True))
                    db.commit()
                    break

    if not chosen:
        power_logger.info("NO-PEER-APPROVED title=%s ep=%s", title.name_ua, ep.number)
        raise ValueError("Ніхто не погодився надати потужність")

    # Ship the audio to the chosen peer and run separation there.
    power_logger.info("DISPATCH peer=%s title=%s ep=%s", chosen["host"], title.name_ua, ep.number)
    with open(ep.audio_stem_path, "rb") as f:
        resp = requests.post(
            f"{peer_base_url(chosen['host'], chosen['port'])}/api/power-share/run-separation",
            files={"audio": (os.path.basename(ep.audio_stem_path), f, "audio/wav")},
            data={
                "model": model,
                "ensemble": str(ensemble).lower(),
                "requester_name": payload["requester_name"],
                "title_name": title.name_ua,
                "episode_number": ep.number,
            },
            timeout=3600,
        )
    resp.raise_for_status()

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
    return {"vocal_stem_path": final_vocal, "peer": chosen["name"]}
