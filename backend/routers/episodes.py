import asyncio
import os
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List

from ..database import get_db
from ..models import Episode, Title, SubtitleLine, Character
from ..schemas import EpisodeCreate, EpisodeUpdate, EpisodeOut, ImportVideoRequest
from .. import job_manager

router = APIRouter(tags=["episodes"])


def _episode_out(ep: Episode, db: Session) -> EpisodeOut:
    count = db.query(func.count(SubtitleLine.id)).filter(SubtitleLine.episode_id == ep.id).scalar()
    out = EpisodeOut.model_validate(ep)
    out.subtitle_count = count or 0
    return out


@router.get("/titles/{title_id}/episodes", response_model=List[EpisodeOut])
def list_episodes(title_id: int, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    eps = db.query(Episode).filter(Episode.title_id == title_id).order_by(Episode.season, Episode.number).all()
    return [_episode_out(ep, db) for ep in eps]


@router.post("/titles/{title_id}/episodes", response_model=EpisodeOut, status_code=201)
def create_episode(title_id: int, body: EpisodeCreate, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    ep = Episode(title_id=title_id, **body.model_dump())
    db.add(ep)
    db.commit()
    db.refresh(ep)
    return _episode_out(ep, db)


@router.get("/episodes/{ep_id}", response_model=EpisodeOut)
def get_episode(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    return _episode_out(ep, db)


@router.put("/episodes/{ep_id}", response_model=EpisodeOut)
def update_episode(ep_id: int, body: EpisodeUpdate, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(ep, k, v)
    db.commit()
    db.refresh(ep)
    return _episode_out(ep, db)


@router.delete("/episodes/{ep_id}", status_code=204)
def delete_episode(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    db.delete(ep)
    db.commit()


@router.post("/titles/{title_id}/import-video")
async def import_video(
    title_id: int,
    body: ImportVideoRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    if not os.path.isfile(body.file_path):
        raise HTTPException(400, f"File not found: {body.file_path}")

    # Create episode record
    existing = (
        db.query(Episode)
        .filter(Episode.title_id == title_id, Episode.season == body.season, Episode.number == body.episode_number)
        .first()
    )
    if existing:
        ep = existing
    else:
        ep = Episode(title_id=title_id, season=body.season, number=body.episode_number, status="processing")
        db.add(ep)
        db.commit()
        db.refresh(ep)

    job = job_manager.create_job("import_video", episode_id=ep.id)

    from ..services.ffmpeg_service import run_import_pipeline
    loop = asyncio.get_event_loop()
    ep_id_for_job = ep.id
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_import_pipeline(ep_id_for_job, body.file_path, r))
    )

    return {"job_id": job.id, "episode": _episode_out(ep, db)}


@router.post("/episodes/{ep_id}/separate-vocals")
async def separate_vocals(ep_id: int, request: Request, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
        raise HTTPException(400, "Audio stem not found — import video first")

    body = await request.json()
    model = body.get("model", "MDX23C")
    ensemble = body.get("ensemble", False)

    job = job_manager.create_job("separate_vocals", episode_id=ep_id)

    from ..services.separator_service import run_separation
    loop = asyncio.get_event_loop()
    audio_stem_path = ep.audio_stem_path
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_separation(ep_id, audio_stem_path, model, ensemble, r))
    )

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/detect-markers")
async def detect_markers(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    if not ep.vocal_stem_path or not os.path.isfile(ep.vocal_stem_path):
        raise HTTPException(400, "Vocal stem not found — run vocal isolation first")

    job = job_manager.create_job("detect_markers", episode_id=ep_id)

    from ..services.vad_service import run_marker_detection
    loop = asyncio.get_event_loop()

    # Collect character codes for this episode's title
    chars = db.query(Character).filter(Character.title_id == ep.title_id).all()
    char_codes = {c.name: c.code for c in chars}
    vocal_stem_path = ep.vocal_stem_path

    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_marker_detection(ep_id, vocal_stem_path, char_codes, r))
    )

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/mux-audio")
async def mux_audio(ep_id: int, request: Request, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    body = await request.json()
    mixed_audio_path = body.get("mixed_audio_path")
    if not mixed_audio_path or not os.path.isfile(mixed_audio_path):
        raise HTTPException(400, "mixed_audio_path not found")

    job = job_manager.create_job("mux_audio", episode_id=ep_id)

    from ..services.ffmpeg_service import run_mux_pipeline
    loop = asyncio.get_event_loop()
    original_file_path = ep.original_file_path
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_mux_pipeline(ep_id, original_file_path, mixed_audio_path, r))
    )

    return {"job_id": job.id}


@router.get("/stream")
def stream_video(path: str):
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path, media_type="video/mp4")
