import asyncio
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from sqlalchemy.orm import Session
import tempfile
import os

from .. import job_manager
from ..database import get_db
from ..models import AppSettings, Profile
from ..schemas import PowerShareRequestIn, PowerShareRespondIn, PowerShareDecisionOut
from ..services import power_share_service as pss
from ..services import discovery_service
from ..services.gpu_service import get_gpu_info
from ..services.separator_service import separate_file

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
    tmp_dir = tempfile.mkdtemp(prefix="rh_power_share_")
    input_path = os.path.join(tmp_dir, audio.filename or "input.wav")
    with open(input_path, "wb") as f:
        f.write(await audio.read())

    loop = asyncio.get_event_loop()

    async def broadcast_lending(active: bool):
        if job_manager._ws_broadcast:
            await job_manager._ws_broadcast({
                "type": "power_share_lending",
                "data": {
                    "active": active,
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
    finally:
        await broadcast_lending(False)

    with open(final_vocal, "rb") as f:
        data = f.read()
    return Response(content=data, media_type="audio/wav")


@router.post("/episodes/{ep_id}/request-remote-separation")
async def request_remote_separation(ep_id: int, body: dict, db: Session = Depends(get_db)):
    model = body.get("model", "MDX-Net")
    ensemble = body.get("ensemble", False)
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, pss.request_remote_power, ep_id, model, ensemble, db,
        )
        return result
    except ValueError as exc:
        raise HTTPException(409, str(exc))
