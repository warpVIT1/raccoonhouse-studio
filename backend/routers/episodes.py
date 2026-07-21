import asyncio
import mimetypes
import os
import re
import shutil
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List

from ..database import get_db
from ..models import Episode, Title, SubtitleLine, Character
from ..schemas import EpisodeCreate, EpisodeUpdate, EpisodeOut, ImportVideoRequest
from .. import job_manager

router = APIRouter(tags=["episodes"])

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def delete_episode_files(episode_id: int) -> None:
    """Remove the on-disk episode-<id> directory (stems, proxies, extracted
    audio, dubbed exports). Without this, deleting the DB row alone leaves
    everything on disk forever — and since SQLite reuses a deleted row's id
    for the next insert, a brand new episode/title can end up reading a
    leftover file (e.g. vocal_isolated.wav) from a completely different,
    already-deleted show that happened to get the same id."""
    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    shutil.rmtree(ep_dir, ignore_errors=True)


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
async def delete_episode(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    db.delete(ep)
    db.commit()
    delete_episode_files(ep_id)

    # Cancel any job still running for this episode (e.g. an ffmpeg import in
    # progress) and tell the frontend so it stops showing a stale percent for
    # a job whose episode no longer exists.
    cancelled_ids = job_manager.cancel_jobs_for_episode(ep_id)
    if cancelled_ids and job_manager._ws_broadcast:
        for job_id in cancelled_ids:
            await job_manager._ws_broadcast({"type": "error", "job_id": job_id, "error": "Серію видалено"})


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
    # VAD needs an actual voice signal to find speech gaps in — vocal_stem_path
    # is the instrumental (vocal removed) now, so this must read
    # vocal_only_stem_path instead. Episodes separated on a peer machine via
    # power-share never get this field populated (only the instrumental
    # crosses the wire), so they need a clear error rather than silently
    # running VAD against the wrong (or missing) file.
    if not ep.vocal_only_stem_path or not os.path.isfile(ep.vocal_only_stem_path):
        raise HTTPException(400, "Vocal-only stem not found — run vocal isolation first (locally, not via power-share)")

    job = job_manager.create_job("detect_markers", episode_id=ep_id)

    from ..services.vad_service import run_marker_detection
    loop = asyncio.get_event_loop()

    # Collect character codes for this episode's title
    chars = db.query(Character).filter(Character.title_id == ep.title_id).all()
    char_codes = {c.name: c.code for c in chars}
    vocal_only_stem_path = ep.vocal_only_stem_path

    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_marker_detection(ep_id, vocal_only_stem_path, char_codes, r))
    )

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/mux-audio")
async def mux_audio(ep_id: int, request: Request, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    # Renders straight from the episode's own instrumental (vocal_stem_path —
    # original vocal already removed by separation) muxed against the
    # original video — no external Reaper-mixed file needed or accepted
    # anymore, this is now a one-click render of what's already there.
    mixed_audio_path = ep.vocal_stem_path
    if not mixed_audio_path or not os.path.isfile(mixed_audio_path):
        raise HTTPException(400, "Інструментал не знайдено — виконайте ізоляцію вокалу спочатку")

    # Optional output_dir (user-picked via the native folder dialog) — falls
    # back to the episode's own data-dir folder if omitted, same as before.
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    output_dir = body.get("output_dir")

    job = job_manager.create_job("mux_audio", episode_id=ep_id)

    from ..services.ffmpeg_service import run_mux_pipeline
    loop = asyncio.get_event_loop()
    original_file_path = ep.original_file_path
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_mux_pipeline(ep_id, original_file_path, mixed_audio_path, r, output_dir))
    )

    return {"job_id": job.id}


STREAM_CHUNK_SIZE = 1024 * 1024


@router.get("/stream")
def stream_video(path: str, request: Request):
    if not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    # Serves both the original video and the isolated vocal stem (for the
    # original/vocal A-B toggle in the player) — a hardcoded video/mp4 type
    # was wrong for the latter (a .wav), so guess it from the actual file.
    guessed, _ = mimetypes.guess_type(path)
    media_type = guessed or "application/octet-stream"
    file_size = os.path.getsize(path)

    # Starlette's FileResponse (0.37.x, pinned via fastapi==0.111.1) ignores
    # the Range header entirely and always returns the whole file with a 200
    # — Range support for FileResponse only landed in a later Starlette
    # release. Without a 206/Content-Range response, <video>.currentTime
    # seeking on anything but a fully-buffered file silently does nothing,
    # which is exactly what it looked like on a real ~130MB episode (a tiny
    # multi-second test file never exposed this, since the whole thing
    # buffers instantly). Handle Range manually instead of upgrading
    # Starlette, since requirements.txt pins fastapi/starlette deliberately
    # for unrelated reasons documented there.
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=media_type, headers={"Accept-Ranges": "bytes"})

    match = re.match(r"bytes=(\d*)-(\d*)", range_header)
    if not match or not (match.group(1) or match.group(2)):
        raise HTTPException(416, "Invalid Range header", headers={"Content-Range": f"bytes */{file_size}"})

    start = int(match.group(1)) if match.group(1) else max(0, file_size - int(match.group(2)))
    end = int(match.group(2)) if match.group(1) and match.group(2) else file_size - 1
    end = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise HTTPException(416, "Requested range not satisfiable", headers={"Content-Range": f"bytes */{file_size}"})

    def iter_range():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(STREAM_CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    return StreamingResponse(
        iter_range(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(end - start + 1),
        },
    )
