import asyncio
import shutil
import zipfile
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy.orm import Session
import tempfile
import os

from .. import job_manager
from ..database import get_db
from ..models import AppSettings, Profile, Episode, Title
from ..schemas import PowerShareRequestIn, PowerShareRespondIn, PowerShareDecisionOut
from ..services import power_share_service as pss
from ..services import discovery_service
from ..services.gpu_service import get_gpu_info
from ..services.separator_service import separate_file
from ..services.ffmpeg_service import run_import_ffmpeg_only

router = APIRouter(tags=["power-share"])


@router.get("/power-share/discovered")
def discovered_peers():
    """Peers found automatically on the LAN in the last few seconds — no manual
    IP entry. Each entry already carries its own power_share_enabled/logged_in
    state (self-reported in its broadcast), so no extra reachability round-trip
    is needed to know if it's usable."""
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


@router.get("/power-share/status")
def power_share_status(db: Session = Depends(get_db)):
    """Probe endpoint used both by the LAN 'test' action and by the manual
    direct-connect fallback (see AppSettings.manual_peer_host) to learn
    everything about a peer in one round-trip over plain HTTP — this is what
    lets two PCs connect even when UDP broadcast can't reach between them
    (different networks, or a VPN mesh like Hamachi/Radmin that doesn't
    relay broadcast traffic the way a real LAN does)."""
    settings = db.get(AppSettings, 1)
    name = "?"
    if settings and settings.active_profile_id:
        profile = db.get(Profile, settings.active_profile_id)
        if profile:
            name = profile.name
    gpu = get_gpu_info()
    return {
        "name": name,
        "power_share_enabled": bool(settings and settings.power_share_enabled),
        "logged_in": bool(settings and settings.active_profile_id),
        "gpu_name": gpu["name"],
        "vram_gb": gpu["vram_gb"],
    }


@router.post("/power-share/consent-request", response_model=PowerShareDecisionOut)
async def consent_request(body: PowerShareRequestIn):
    loop = asyncio.get_event_loop()
    approved, reason = await loop.run_in_executor(
        None,
        pss.handle_incoming_consent_request,
        body.model_dump(),
        job_manager._ws_broadcast,
        loop,
    )
    return PowerShareDecisionOut(request_id="", approved=approved, reason=reason)


@router.post("/power-share/respond")
def consent_respond(body: PowerShareRespondIn):
    ok = pss.respond_to_request(body.request_id, body.approved)
    if not ok:
        raise HTTPException(404, "Запит вже завершено або не знайдено")
    return {"ok": True}


@router.post("/power-share/run-separation")
async def run_separation_for_peer(
    audio: UploadFile = File(...),
    model: str = Form("MDX-Net"),
    ensemble: str = Form("false"),
    requester_name: str = Form("?"),
    title_name: str = Form("?"),
    episode_number: int = Form(0),
):
    """Runs on the RESPONDER machine — receives another instance's audio,
    separates it locally, and streams the resulting stem back. Broadcasts a
    WS status so THIS machine's own UI shows "lending power" the whole time —
    otherwise the person whose PC is doing the work would have zero visibility
    that it's happening at all."""
    pss.power_logger.info("RUN-SEPARATION-RECEIVED requester=%s title=%s ep=%s model=%s", requester_name, title_name, episode_number, model)
    tmp_dir = tempfile.mkdtemp(prefix="rh_power_share_")
    try:
        input_path = os.path.join(tmp_dir, audio.filename or "input.flac")
        with open(input_path, "wb") as f:
            f.write(await audio.read())
        pss.power_logger.info("RUN-SEPARATION-SAVED-INPUT path=%s size=%s", input_path, os.path.getsize(input_path))

        loop = asyncio.get_event_loop()

        async def broadcast_lending(active: bool):
            if job_manager._ws_broadcast:
                await job_manager._ws_broadcast({
                    "type": "power_share_lending",
                    "data": {
                        "active": active,
                        "task": "separate",
                        "requester_name": requester_name,
                        "title_name": title_name,
                        "episode_number": episode_number,
                    },
                })

        await broadcast_lending(True)
        try:
            output_dir = os.path.join(tmp_dir, "out")
            final_vocal = await loop.run_in_executor(
                None, separate_file, input_path, output_dir, model, ensemble.lower() == "true",
            )
            pss.power_logger.info("RUN-SEPARATION-DONE final_vocal=%s", final_vocal)
        finally:
            await broadcast_lending(False)

        with open(final_vocal, "rb") as f:
            data = f.read()
        pss.power_logger.info("RUN-SEPARATION-RESPONDING bytes=%s", len(data))
        return Response(content=data, media_type="audio/wav")
    except Exception as exc:
        pss.power_logger.exception("RUN-SEPARATION-ERROR %s", exc)
        raise
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/power-share/run-import")
async def run_import_for_peer(
    request: Request,
    filename: str = "input.mkv",
    requester_name: str = "?",
    title_name: str = "?",
    episode_number: int = 0,
):
    """Runs on the RESPONDER machine — receives another instance's ORIGINAL
    video file (streamed straight to disk, not buffered in memory — these can
    be multiple GB), runs the ffmpeg extraction+proxy pipeline locally, and
    streams back a zip with both outputs. Meant for a requester whose own PC
    is too weak to comfortably run ffmpeg itself, so this step happens BEFORE
    any local processing on the requester's side."""
    tmp_dir = tempfile.mkdtemp(prefix="rh_power_import_")
    try:
        input_path = os.path.join(tmp_dir, filename)
        with open(input_path, "wb") as f:
            async for chunk in request.stream():
                f.write(chunk)

        loop = asyncio.get_event_loop()

        async def broadcast_lending(active: bool):
            if job_manager._ws_broadcast:
                await job_manager._ws_broadcast({
                    "type": "power_share_lending",
                    "data": {
                        "active": active,
                        "task": "import",
                        "requester_name": requester_name,
                        "title_name": title_name,
                        "episode_number": episode_number,
                    },
                })

        await broadcast_lending(True)
        try:
            out_dir = os.path.join(tmp_dir, "out")
            result = await loop.run_in_executor(None, run_import_ffmpeg_only, input_path, out_dir)
        finally:
            await broadcast_lending(False)

        zip_path = os.path.join(tmp_dir, "result.zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(result["audio_path"], "audio_full.flac")
            zf.write(result["proxy_path"], "proxy_480p.mp4")

        with open(zip_path, "rb") as f:
            data = f.read()
        headers = {
            "X-Duration": str(result["duration"] or 0),
            "X-Bitrate": str(result["bit_rate"] or 0),
            "X-Format": result["format_name"] or "",
            "X-File-Size": str(result["file_size"]),
        }
        return Response(content=data, media_type="application/zip", headers=headers)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/episodes/{ep_id}/request-remote-separation")
async def request_remote_separation(ep_id: int, body: dict, db: Session = Depends(get_db)):
    model = body.get("model", "MDX-Net")
    ensemble = body.get("ensemble", False)

    job = job_manager.create_job("request_remote_separation", episode_id=ep_id)
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: pss.request_remote_power(ep_id, model, ensemble, r))
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
