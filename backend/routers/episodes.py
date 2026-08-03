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
from ..services.power_share_service import app_logger
from ..services.title_status import bump_title_in_progress

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
        app_logger.warning("import-video: title %s not found", title_id)
        raise HTTPException(404, "Title not found")
    if not os.path.isfile(body.file_path):
        app_logger.warning("import-video: file not found: %r", body.file_path)
        raise HTTPException(400, f"File not found: {body.file_path}")
    app_logger.info("import-video: title=%s season=%s episode=%s file=%s", title_id, body.season, body.episode_number, body.file_path)

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
        app_logger.warning("separate-vocals: episode %s not found", ep_id)
        raise HTTPException(404)
    if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
        app_logger.warning(
            "separate-vocals: episode %s has no audio stem (audio_stem_path=%r) — import video first",
            ep_id, ep.audio_stem_path,
        )
        raise HTTPException(400, "Audio stem not found — import video first")

    body = await request.json()
    model = body.get("model", "MDX23C")
    ensemble = body.get("ensemble", False)
    model_file = body.get("model_file")
    params = body.get("params")
    app_logger.info(
        "separate-vocals: episode=%s model=%s ensemble=%s model_file=%s params=%s",
        ep_id, model, ensemble, model_file, params,
    )

    job = job_manager.create_job("separate_vocals", episode_id=ep_id)

    from ..services.separator_service import run_separation
    loop = asyncio.get_event_loop()
    audio_stem_path = ep.audio_stem_path
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_separation(ep_id, audio_stem_path, model, ensemble, r, model_file=model_file, params=params))
    )

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/batch-separate-vocals")
async def batch_separate_vocals(ep_id: int, request: Request, db: Session = Depends(get_db)):
    """Like Ensemble Mode (runs all 5 models), but keeps each model's result
    as its own separate file instead of averaging them into one blended
    output — see separator_service.separate_file_batch's docstring."""
    ep = db.get(Episode, ep_id)
    if not ep:
        app_logger.warning("batch-separate-vocals: episode %s not found", ep_id)
        raise HTTPException(404)
    if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
        app_logger.warning("batch-separate-vocals: episode %s has no audio stem", ep_id)
        raise HTTPException(400, "Audio stem not found — import video first")
    app_logger.info("batch-separate-vocals: episode=%s", ep_id)

    # Optional output_dir (user-picked via the native folder dialog, same
    # pattern as mux-audio above) — falls back to the episode's own data-dir
    # folder if omitted.
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    output_dir = body.get("output_dir")

    job = job_manager.create_job("batch_separate_vocals", episode_id=ep_id)

    from ..services.separator_service import run_batch_separation
    loop = asyncio.get_event_loop()
    audio_stem_path = ep.audio_stem_path
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_batch_separation(ep_id, audio_stem_path, r, output_dir=output_dir))
    )

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/use-batch-result")
async def use_batch_result(ep_id: int, request: Request, db: Session = Depends(get_db)):
    """Batch mode (see batch_separate_vocals above) deliberately never sets
    the episode's own vocal_stem_path — it produces N comparison files with
    no single "the" result to promote. This is how the user actually picks
    one of those N files to become the episode's real instrumental, so
    "Рендерити фінальну доріжку" (which reads vocal_stem_path directly, see
    mux_audio below) has something to work with."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Невірне тіло запиту")
    path = body.get("path")
    job_id = body.get("job_id")
    if not path or not job_id:
        raise HTTPException(400, "path і job_id обов'язкові")

    # The batch output folder can now be anywhere the user picked via the
    # native folder dialog (see batch_separate_vocals' output_dir), so a
    # fixed-directory prefix check no longer works — instead, only accept a
    # path that's literally one of THIS job's own recorded results. Never
    # accept an arbitrary filesystem path from the request body.
    job = job_manager.get_job(job_id)
    if (
        not job
        or job.episode_id != ep_id
        or job.type != "batch_separate_vocals"
        or path not in (job.result.get("models") or {}).values()
    ):
        app_logger.warning("use-batch-result: rejected path=%r job_id=%r for episode %s", path, job_id, ep_id)
        raise HTTPException(400, "Невірний шлях до файлу")

    if not os.path.isfile(path):
        raise HTTPException(400, "Файл більше не існує")

    # Unconditional, same as a normal (non-batch) separation run (see
    # run_separation in separator_service.py) — picking a batch result
    # changes vocal_stem_path just as much as any other separation does, so
    # it needs to downgrade an already-"marked"/"ready" episode the same
    # way. Previously guarded against downgrading, which left the tile
    # showing "Готово" (or "Промарковано") after swapping in a different
    # batch model even though the final render (or markers) on file were
    # now stale for the newly picked instrumental.
    ep.vocal_stem_path = path
    ep.status = "vocal_isolated"
    bump_title_in_progress(db, ep.title_id)
    db.commit()
    app_logger.info("use-batch-result: episode %s now uses %s", ep_id, path)
    return {"ok": True}


@router.post("/episodes/{ep_id}/distributed-separate-vocals")
async def distributed_separate_vocals(ep_id: int, request: Request, db: Session = Depends(get_db)):
    """Splits the episode's audio across every currently-available Power
    Share peer (plus this machine) and runs each piece's separation in
    parallel — see distributed_separation_service.py's module docstring.
    Falls back to plain local separation automatically if no peers accept."""
    ep = db.get(Episode, ep_id)
    if not ep:
        app_logger.warning("distributed-separate-vocals: episode %s not found", ep_id)
        raise HTTPException(404)
    if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
        app_logger.warning("distributed-separate-vocals: episode %s has no audio stem", ep_id)
        raise HTTPException(400, "Audio stem not found — import video first")

    body = await request.json()
    model = body.get("model", "MDX23C")
    ensemble = body.get("ensemble", False)
    model_file = body.get("model_file")
    params = body.get("params")
    app_logger.info(
        "distributed-separate-vocals: episode=%s model=%s ensemble=%s model_file=%s params=%s",
        ep_id, model, ensemble, model_file, params,
    )

    job = job_manager.create_job("distributed_separate_vocals", episode_id=ep_id)

    from ..services.distributed_separation_service import run_distributed_separation
    loop = asyncio.get_event_loop()
    # audio_stem_path deliberately not extracted here — unlike separate-vocals/
    # batch-separate-vocals, run_distributed_separation opens its own DB
    # session and re-reads it itself (it needs a live Episode/Title anyway
    # for the peer-consent broadcast).
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_distributed_separation(ep_id, model, ensemble, r, model_file=model_file, params=params))
    )

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/detect-markers")
async def detect_markers(ep_id: int, db: Session = Depends(get_db)):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    # VAD needs an actual voice signal to find speech gaps in — vocal_stem_path
    # is the instrumental (vocal removed) now, so this must read
    # vocal_only_stem_path instead. Power-share/distributed separation now
    # transfers both stems back, so this should only ever trigger for an
    # episode that hasn't had vocal separation run at all yet, or one
    # separated by an older app version (pre-dual-stem-transfer) or a peer
    # still running one.
    if not ep.vocal_only_stem_path or not os.path.isfile(ep.vocal_only_stem_path):
        app_logger.warning(
            "detect-markers: episode %s has no vocal-only stem (vocal_only_stem_path=%r)",
            ep_id, ep.vocal_only_stem_path,
        )
        raise HTTPException(400, "Vocal-only stem not found — run vocal isolation first")
    app_logger.info("detect-markers: episode=%s", ep_id)

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
        app_logger.warning("mux-audio: episode %s has no instrumental (vocal_stem_path=%r)", ep_id, mixed_audio_path)
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
