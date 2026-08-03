import asyncio
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import job_manager
from ..database import get_db
from ..models import AppSettings, Episode, Title, Profile
from ..schemas import PowerShareRespondIn
from ..services import power_share_service as pss
from ..services import discovery_service
from ..services.gpu_service import get_gpu_info

router = APIRouter(tags=["power-share"])


@router.get("/power-share/discovered")
def discovered_peers():
    """Peers currently online via the Cloudflare signaling Worker — no LAN
    broadcast, no manual IP entry. Each entry already carries its own
    power_share_enabled/logged_in state (self-reported in its "hello"), so
    no extra reachability round-trip is needed to know if it's usable."""
    peers = discovery_service.get_discovered_peers()
    for p in peers:
        p["available"] = p["power_share_enabled"] and p["logged_in"]
    return peers


@router.get("/power-share/overview")
def power_share_overview(db: Session = Depends(get_db)):
    """Aggregate view for Settings' "Загальна потужність" tab."""
    peers = discovery_service.get_discovered_peers()
    for p in peers:
        p["available"] = p["power_share_enabled"] and p["logged_in"]
    available_count = sum(1 for p in peers if p["available"])

    settings = db.get(AppSettings, 1)
    own_gpu = get_gpu_info()
    return {
        "this_machine_enabled": bool(settings and settings.power_share_enabled),
        "own_gpu_name": own_gpu["name"],
        "own_vram_gb": own_gpu["vram_gb"],
        "total_peers": len(peers),
        "available_peers": available_count,
        "peers": peers,
    }


@router.post("/power-share/respond")
def consent_respond(body: PowerShareRespondIn):
    ok = pss.respond_to_request(body.request_id, body.approved)
    if not ok:
        raise HTTPException(404, "Запит вже завершено або не знайдено")
    return {"ok": True}


@router.post("/power-share/respond-model-download")
def model_download_respond(body: PowerShareRespondIn):
    ok = pss.respond_to_model_download_request(body.request_id, body.approved)
    if not ok:
        raise HTTPException(404, "Запит вже завершено або не знайдено")
    return {"ok": True}


@router.post("/power-share/broadcast-force-update")
def broadcast_force_update(db: Session = Depends(get_db)):
    # Admin-only nudge, not an actual forced download/install (an admin
    # forcibly restarting someone else's app mid-render would destroy active
    # work) — just a dismissible "go check for an update" notice pushed to
    # every currently-online peer over the relay.
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    if not profile or not profile.is_admin:
        raise HTTPException(403, "Лише адмін може надсилати це всім")
    sent = discovery_service.broadcast_force_update_request(profile.name)
    return {"sent": sent}


@router.get("/power-share/peers/{peer_id}/log")
def get_peer_log(peer_id: str, filename: str, db: Session = Depends(get_db)):
    # Admin-only — read-only view of a PEER's own log files (view/download/
    # copy in the UI), never this machine's, never editable: there is no
    # corresponding PUT/POST anywhere in this router or the relay protocol.
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    if not profile or not profile.is_admin:
        raise HTTPException(403, "Лише адмін може переглядати журнали інших ПК")
    try:
        content = discovery_service.fetch_peer_log(peer_id, filename)
    except TimeoutError:
        raise HTTPException(504, "ПК не відповів вчасно")
    except ValueError as e:
        raise HTTPException(502, str(e))
    return {"content": content}


@router.post("/episodes/{ep_id}/request-remote-separation")
async def request_remote_separation(ep_id: int, body: dict, db: Session = Depends(get_db)):
    model = body.get("model", "MDX-Net")
    ensemble = body.get("ensemble", False)
    model_file = body.get("model_file")
    params = body.get("params")

    job = job_manager.create_job("request_remote_separation", episode_id=ep_id)
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: pss.request_remote_power(ep_id, model, ensemble, r, model_file=model_file, params=params))
    )
    return {"job_id": job.id}


@router.post("/titles/{title_id}/request-remote-import")
async def request_remote_import(title_id: int, body: dict, db: Session = Depends(get_db)):
    """Mirrors POST /titles/{id}/import-video, except the ffmpeg work itself
    runs on a peer instead of locally — offered up front, before any local
    processing starts, for a requester PC too weak to comfortably run ffmpeg."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    file_path = body.get("file_path")
    if not file_path or not os.path.isfile(file_path):
        raise HTTPException(400, f"File not found: {file_path}")
    season = body.get("season", 1)
    episode_number = body.get("episode_number")
    if episode_number is None:
        raise HTTPException(400, "episode_number is required")

    existing = (
        db.query(Episode)
        .filter(Episode.title_id == title_id, Episode.season == season, Episode.number == episode_number)
        .first()
    )
    if existing:
        ep = existing
    else:
        ep = Episode(title_id=title_id, season=season, number=episode_number, status="processing")
        db.add(ep)
        db.commit()
        db.refresh(ep)

    job = job_manager.create_job("import_video_remote", episode_id=ep.id)
    loop = asyncio.get_event_loop()
    ep_id_for_job = ep.id
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: pss.request_remote_import(ep_id_for_job, file_path, r))
    )

    from .episodes import _episode_out
    return {"job_id": job.id, "episode": _episode_out(ep, db)}


@router.post("/episodes/{ep_id}/request-remote-render")
async def request_remote_render_endpoint(ep_id: int, body: dict, db: Session = Depends(get_db)):
    """Mirrors POST /episodes/{id}/mux-audio, except the final ffmpeg mux
    itself runs on a peer instead of locally — sends the original video and
    the episode's own instrumental (as FLAC, to shrink the upload) to a peer,
    gets back the finished dub video."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    output_dir = body.get("output_dir")

    job = job_manager.create_job("request_remote_render", episode_id=ep_id)
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: pss.request_remote_render(ep_id, output_dir, r))
    )
    return {"job_id": job.id}
