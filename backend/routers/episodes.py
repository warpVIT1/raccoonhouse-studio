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
from typing import List, Optional

from ..database import get_db
from ..models import (
    ActorAudioSubmission, AppSettings, Character, Episode, EpisodeRoleAssignment, EpisodeRoleDeadline, Marker,
    Profile, RoleCatalog, Title, SubtitleLine, TitleRoleAssignment,
)
from ..schemas import (
    ActorReaperProjectRequest, CleanedVideoSubmitRequest, EpisodeAdminPersonStatus, EpisodeCreate, EpisodeUpdate,
    EpisodeOut, EpisodeRoleAssignmentOut, EpisodeRoleAssignmentSet, EpisodeRoleDeadlineOut, EpisodeRoleDeadlineSet,
    ImportVideoRequest, RemindRequest, SendToActorRequest,
)
from .. import job_manager
from ..services.power_share_service import app_logger
from ..services.title_status import bump_title_in_progress

router = APIRouter(tags=["episodes"])

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def _ensure_audio_stem(ep: Episode, db: Session) -> bool:
    """Self-heals episodes stuck with a real original_file_path but no
    audio_stem_path — confirmed live 2026-09-08: sync_service.
    download_episode_video used to skip audio extraction entirely (a
    documented scope limit from an earlier session), so every episode
    pulled that way before the fix landed is permanently stuck failing
    every separate-vocals attempt with "Audio stem not found — import
    video first", since the video-download banner only shows up when
    original_file_path is EMPTY — there was no way to retrigger extraction
    for an episode that already has its video. Runs the same ffmpeg
    extraction step on demand instead of hard-failing; returns True if
    audio_stem_path is now valid (freshly extracted or already was)."""
    if ep.audio_stem_path and os.path.isfile(ep.audio_stem_path):
        return True
    if not ep.original_file_path or not os.path.isfile(ep.original_file_path):
        return False
    from ..services.ffmpeg_service import run_import_ffmpeg_only
    ep_dir = Path(DATA_DIR) / "episodes" / str(ep.id)
    try:
        result = run_import_ffmpeg_only(ep.original_file_path, str(ep_dir))
    except Exception:
        app_logger.exception("_ensure_audio_stem: extraction failed for episode %s", ep.id)
        return False
    ep.audio_stem_path = result["audio_path"]
    if not ep.original_size:
        ep.original_size = result["file_size"]
    if not ep.original_bitrate:
        ep.original_bitrate = result["bit_rate"]
    if not ep.original_format:
        ep.original_format = result["format_name"]
    if not ep.duration:
        ep.duration = result["duration"]
    db.commit()
    return True


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


@router.post("/episodes/{ep_id}/send-to-director")
def send_to_director(ep_id: int, db: Session = Depends(get_db)):
    """Translator -> director handoff: marks the episode's subtitles ready
    and best-effort notifies whoever on the team has the director role via
    Telegram (see discovery_service.notify_director / the Worker's
    /notify-director route). The stage change always sticks even if nobody
    gets notified (no active team, signaling off) — `notified` tells the
    frontend which happened."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    ep.subtitle_stage = "ready_for_director"
    db.commit()
    title = db.get(Title, ep.title_id)
    message = f"Переклад готовий: {title.name_ua} — серія {ep.number}. Потрібно розставити ролі та перевірити субтитри."
    from ..services import discovery_service, sync_service
    notified = sync_service.notify_role_for_title(title, "director", message, discovery_service.notify_director, db, episode=ep)
    return {"subtitle_stage": ep.subtitle_stage, "notified": notified}


@router.post("/episodes/{ep_id}/send-to-actors")
async def send_to_actors(ep_id: int, db: Session = Depends(get_db)):
    """Director -> actors handoff, one stage further than send_to_director
    above. Kicks off a background job (same pattern as mux-audio) that burns
    the current subtitles into a compressed 480p proxy and uploads it to R2
    (see services/actor_video_service.run_export_actor_video) — the Telegram
    notify only fires once that upload actually succeeds, from inside the
    job itself, so actors aren't pinged before there's anything to download."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    ep.subtitle_stage = "ready_for_actors"
    db.commit()

    job = job_manager.create_job("export_actor_video", episode_id=ep_id)
    from ..services.actor_video_service import run_export_actor_video
    loop = asyncio.get_event_loop()
    asyncio.create_task(job_manager.run_job(loop, job, lambda r: run_export_actor_video(ep_id, r)))

    return {"job_id": job.id, "subtitle_stage": ep.subtitle_stage}


@router.post("/episodes/{ep_id}/send-to-actor")
async def send_to_actor(ep_id: int, body: SendToActorRequest, db: Session = Depends(get_db)):
    """DirectorWorkspace's per-character "Тільки цьому актору" button — same
    job as send_to_actors above, but scoped to one character
    (run_export_actor_video's only_character_id). If the shared video was
    already generated for this episode, the job skips straight to notifying
    just this one actor instead of re-encoding (see
    actor_video_service._run_export_actor_video's own comment)."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    job = job_manager.create_job("export_actor_video", episode_id=ep_id)
    from ..services.actor_video_service import run_export_actor_video
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_export_actor_video(ep_id, r, body.character_id))
    )

    return {"job_id": job.id}


@router.get("/episodes/{ep_id}/actor-video-url")
def get_actor_video_url(ep_id: int, db: Session = Depends(get_db)):
    """Resolves the latest 480p hardsub proxy's download URL (see
    send_to_actors above) — the frontend never hardcodes the Worker's base
    URL, same posture as avatar_url already being a full Worker URL."""
    ep = db.get(Episode, ep_id)
    if not ep or not ep.actor_video_transfer_id:
        raise HTTPException(404, "Відео для акторів ще не готове")
    from urllib.parse import quote
    from ..services import discovery_service
    from ..services.actor_video_service import _build_video_filename
    base = discovery_service.get_https_base()
    if not base:
        raise HTTPException(400, "Онлайн-сигналізація не налаштована")
    title = db.get(Title, ep.title_id)
    filename = _build_video_filename(title, ep)
    return {"url": f"{base}/transfer/{ep.actor_video_transfer_id}?filename={quote(filename)}"}


@router.post("/episodes/{ep_id}/download-original-video")
async def download_original_video(ep_id: int, db: Session = Depends(get_db)):
    """On-demand pull of the RAW original video from R2 (see
    sync_service.download_episode_video's own comment on why this isn't
    automatic) — a shared episode's video is known (Episode.
    remote_video_transfer_id) the moment a teammate imports and pushes it,
    but nothing downloads it here until this is explicitly called, e.g.
    from the Translator/Director workspace's video panel when
    original_file_path is still empty locally."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    if not ep.remote_video_transfer_id:
        raise HTTPException(404, "Оригінальне відео ще не завантажено в хмару")

    job = job_manager.create_job("download_original_video", episode_id=ep_id)
    from ..services.sync_service import download_episode_video
    loop = asyncio.get_event_loop()
    asyncio.create_task(job_manager.run_job(loop, job, lambda r: download_episode_video(ep_id, r)))

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/actor-reaper-project")
async def generate_actor_reaper_project(ep_id: int, body: ActorReaperProjectRequest, db: Session = Depends(get_db)):
    """ActorWorkspace.tsx's "Відкрити в Reaper" — downloads the 480p hardsub
    video if not already local and generates a ready-to-open .rpp project
    next to it (see reaper_project_service.py's own docstring for the
    track/marker layout). Job-based like every other file-fetching action
    here, since the video download can take a while. Must be async — same
    asyncio.get_event_loop() reason as submit_actor_audio."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    if not ep.actor_video_transfer_id:
        raise HTTPException(400, "Відео для акторів ще не готове")

    job = job_manager.create_job("generate_actor_reaper_project", episode_id=ep_id)
    from ..services.reaper_project_service import run_generate_actor_reaper_project
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_generate_actor_reaper_project(ep_id, body.character_id, r))
    )
    return {"job_id": job.id}

    return {"job_id": job.id}


@router.post("/episodes/{ep_id}/cleaned-video")
async def submit_cleaned_video(ep_id: int, body: CleanedVideoSubmitRequest, db: Session = Depends(get_db)):
    """Клінапер's "Завантажити заклінапене відео" — job-based like the
    actor-audio submit flow, since a video file can be hundreds of MB.
    Re-uploading replaces the previous cleaned video for this episode
    (there's only ever one current one, unlike ActorAudioSubmission). Must
    be async — see submit_actor_audio's own comment on why a plain `def`
    here crashes asyncio.get_event_loop() below."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    job = job_manager.create_job("submit_cleaned_video", episode_id=ep_id)
    from ..services.cleaner_service import run_submit_cleaned_video
    loop = asyncio.get_event_loop()
    asyncio.create_task(job_manager.run_job(loop, job, lambda r: run_submit_cleaned_video(ep_id, body.file_path, r)))
    return {"job_id": job.id}


@router.get("/episodes/{ep_id}/cleaned-video-url")
def get_cleaned_video_url(ep_id: int, db: Session = Depends(get_db)):
    """Download link for whoever picks the episode up next (sound
    engineer/director) — same ?filename= URL-signing pattern as
    actor_audio.py's get_actor_audio_url, no per-role template."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    if not ep.cleaned_video_transfer_id:
        raise HTTPException(404, "Заклінапене відео ще не завантажено")
    from urllib.parse import quote
    from ..services import discovery_service
    base = discovery_service.get_https_base()
    if not base:
        raise HTTPException(400, "Онлайн-сигналізація не налаштована")
    filename = ep.cleaned_video_filename or "cleaned_video.mp4"
    return {"url": f"{base}/transfer/{ep.cleaned_video_transfer_id}?filename={quote(filename)}"}


@router.post("/titles/{title_id}/episodes", response_model=EpisodeOut, status_code=201)
def create_episode(title_id: int, body: EpisodeCreate, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    ep = Episode(title_id=title_id, **body.model_dump())
    db.add(ep)
    db.commit()
    db.refresh(ep)
    if title.shared_id:
        from ..services import sync_service
        sync_service.push_episode(ep.id, db)
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
async def delete_episode(ep_id: int, permanent: bool = False, db: Session = Depends(get_db)):
    """A plain delete only ever removes THIS install's local mirror of a
    shared episode — by design, it comes back on the next pull_and_merge
    (same resilient-by-default posture as routers/titles.py's delete_title).
    `permanent=true` ("Видалити назавжди") additionally deletes the
    cloud-authoritative shared_episodes row, so it's gone for the whole
    team, not just this install."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    shared_id, team_id = ep.shared_id, ep.title.team_id

    if permanent and shared_id and team_id:
        from ..services import team_service
        profile_name = _active_profile_name(db)
        if not profile_name or not team_service.can_manage_team(team_id, profile_name):
            raise HTTPException(403, "Лише адмін команди або адмін програми може видаляти серію назавжди")

    db.delete(ep)
    db.commit()
    delete_episode_files(ep_id)

    if permanent and shared_id and team_id:
        from ..services import device_identity_service, sync_service
        profile_name = _active_profile_name(db)
        if profile_name:
            device_id = device_identity_service.get_profile_id(profile_name)
            sync_service.delete_shared_episode(shared_id, team_id, device_id)

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
    if not _ensure_audio_stem(ep, db):
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

    if model == "MVSep":
        # Server-side re-check, not just the frontend hiding the option —
        # same "hide AND block" posture as every other credits-gated piece.
        from ..services import team_service
        settings = db.get(AppSettings, 1)
        profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
        if not profile or not team_service.is_credits_eligible(profile.name):
            raise HTTPException(403, "MVSep недоступний для цього профілю")

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
    if not _ensure_audio_stem(ep, db):
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
    mvsep_models = body.get("mvsep_models")

    if mvsep_models:
        # MVSep batch — unlike the local batch (always every free model),
        # each entry here spends real studio credits, so it's user-picked
        # and capped, not "run everything." Same "hide AND block" gate as
        # the single-run MVSep path in separate_vocals above.
        from ..services import team_service
        settings = db.get(AppSettings, 1)
        profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
        if not profile or not team_service.is_credits_eligible(profile.name):
            raise HTTPException(403, "MVSep недоступний для цього профілю")
        if not isinstance(mvsep_models, list) or len(mvsep_models) == 0:
            raise HTTPException(400, "Не вказано моделі MVSep")
        if len(mvsep_models) > 5:
            raise HTTPException(400, "Максимум 5 моделей MVSep за один пакетний запуск")

        job = job_manager.create_job("batch_separate_vocals", episode_id=ep_id)
        from ..services.separator_service import run_mvsep_batch_separation
        loop = asyncio.get_event_loop()
        audio_stem_path = ep.audio_stem_path
        asyncio.create_task(
            job_manager.run_job(
                loop, job, lambda r: run_mvsep_batch_separation(ep_id, audio_stem_path, mvsep_models, r, output_dir=output_dir)
            )
        )
        return {"job_id": job.id}

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
    from ..services.separator_service import _archive_previous_isolation
    _archive_previous_isolation(ep, Path(DATA_DIR) / "episodes" / str(ep_id))
    ep.vocal_stem_path = path
    ep.last_separation_model = "Пакетний рендер"
    ep.status = "vocal_isolated"
    bump_title_in_progress(db, ep.title_id)
    db.commit()
    app_logger.info("use-batch-result: episode %s now uses %s", ep_id, path)
    return {"ok": True}


@router.post("/episodes/{ep_id}/mvsep-male-female")
async def mvsep_male_female(ep_id: int, db: Session = Depends(get_db)):
    """"Take a model, separate the vocal, then split THAT into male/female"
    — requires a vocal already isolated (any method, local or MVSep) so
    this doesn't spend a redundant round of MVSep credits re-extracting one
    from scratch; see run_mvsep_male_female_split's own docstring."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    if not ep.vocal_only_stem_path or not os.path.isfile(ep.vocal_only_stem_path):
        raise HTTPException(400, "Спочатку виконайте розділення вокалу — потрібен вже виділений вокал")

    from ..services import team_service
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    if not profile or not team_service.is_credits_eligible(profile.name):
        raise HTTPException(403, "MVSep недоступний для цього профілю")

    job = job_manager.create_job("mvsep_male_female", episode_id=ep_id)
    from ..services.separator_service import run_mvsep_male_female_split
    loop = asyncio.get_event_loop()
    asyncio.create_task(job_manager.run_job(loop, job, lambda r: run_mvsep_male_female_split(ep_id, r)))
    return {"job_id": job.id}


@router.get("/episodes/{ep_id}/separation-history")
def get_separation_history(ep_id: int, db: Session = Depends(get_db)):
    """Past isolation results for this episode, archived automatically each
    time a new run (or a batch-result pick) would otherwise silently
    overwrite the current instrumental — see separator_service's
    _archive_previous_isolation. Auto-deleted after 48h (cleanup_stale_
    separation_history, run periodically from main.py's lifespan)."""
    if not db.get(Episode, ep_id):
        raise HTTPException(404)
    from ..services.separator_service import list_separation_history
    return list_separation_history(ep_id)


@router.post("/episodes/{ep_id}/separation-history/restore")
async def restore_separation_history_endpoint(ep_id: int, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    filename = body.get("filename")
    if not filename:
        raise HTTPException(400, "filename обов'язковий")
    from ..services.separator_service import restore_separation_history
    try:
        result = restore_separation_history(ep_id, filename, db)
    except ValueError as e:
        raise HTTPException(400, str(e))
    bump_title_in_progress(db, db.get(Episode, ep_id).title_id)
    db.commit()
    app_logger.info("restore-separation-history: episode %s restored %s", ep_id, filename)
    return result


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
    if not _ensure_audio_stem(ep, db):
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


# --- Episode "Адмін" tab: deadlines, reminders, production status ---

def _active_profile_name(db: Session) -> "str | None":
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    return profile.name if profile else None


def _require_team_manager_for_episode(ep: Episode, db: Session) -> Title:
    title = db.get(Title, ep.title_id)
    if not title or not title.team_id:
        raise HTTPException(400, "Тайтл не спільний — нема кого призначати")
    from ..services import team_service
    profile_name = _active_profile_name(db)
    if not profile_name or not team_service.can_manage_team(title.team_id, profile_name):
        raise HTTPException(403, "Лише адмін команди або адмін програми")
    return title


@router.get("/episodes/{ep_id}/role-deadlines", response_model=List[EpisodeRoleDeadlineOut])
def list_episode_role_deadlines(ep_id: int, db: Session = Depends(get_db)):
    return db.query(EpisodeRoleDeadline).filter(EpisodeRoleDeadline.episode_id == ep_id).all()


@router.put("/episodes/{ep_id}/role-deadlines/{role}", response_model=Optional[EpisodeRoleDeadlineOut])
def set_episode_role_deadline(
    ep_id: int, role: str, body: EpisodeRoleDeadlineSet, character_id: int | None = None,
    db: Session = Depends(get_db),
):
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    _require_team_manager_for_episode(ep, db)
    row = db.query(EpisodeRoleDeadline).filter(
        EpisodeRoleDeadline.episode_id == ep_id, EpisodeRoleDeadline.role == role,
        EpisodeRoleDeadline.character_id == character_id,
    ).first()
    if not body.deadline:
        if row:
            db.delete(row)
            db.commit()
            if ep.title.shared_id:
                from ..services.sync_service import push_episode_role_deadline
                # A plain, session-detached stand-in — reading attributes
                # off `row` itself here would raise (SQLAlchemy expires an
                # instance's attributes after commit, and this row no
                # longer exists to re-fetch from).
                cleared = EpisodeRoleDeadline(episode_id=ep_id, role=role, character_id=character_id, deadline=None)
                push_episode_role_deadline(cleared, db)
        return None
    if not row:
        row = EpisodeRoleDeadline(episode_id=ep_id, role=role, character_id=character_id)
        db.add(row)
    row.deadline = body.deadline
    db.commit()
    db.refresh(row)
    if ep.title.shared_id:
        from ..services.sync_service import push_episode_role_deadline
        push_episode_role_deadline(row, db)
    return row


@router.get("/episodes/{ep_id}/role-assignments", response_model=List[EpisodeRoleAssignmentOut])
def list_episode_role_assignments(ep_id: int, db: Session = Depends(get_db)):
    return db.query(EpisodeRoleAssignment).filter(EpisodeRoleAssignment.episode_id == ep_id).all()


@router.put("/episodes/{ep_id}/role-assignments/{role}", response_model=Optional[EpisodeRoleAssignmentOut])
def set_episode_role_assignment(
    ep_id: int, role: str, body: EpisodeRoleAssignmentSet, db: Session = Depends(get_db),
):
    """Overrides who holds `role` for THIS episode only (clear with
    device_id=null to fall back to the title's own default — see
    sync_service.resolve_role_assignment). Same replacement-notification
    shape as titles.py's set_title_role_assignment, just worded "для цієї
    серії" instead of implying a title-wide swap."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")
    title = _require_team_manager_for_episode(ep, db)

    from ..services import discovery_service, sync_service
    existing = db.query(EpisodeRoleAssignment).filter(
        EpisodeRoleAssignment.episode_id == ep_id, EpisodeRoleAssignment.role == role,
    ).first()
    old_device_id = existing.device_id if existing else None
    old_name = existing.display_name if existing else None

    if not body.device_id:
        if existing:
            db.delete(existing)
            db.commit()
            if old_device_id:
                discovery_service.notify_device(
                    old_device_id, f"Тебе знято з ролі «{role}» для серії {ep.number} ({title.name_ua}).",
                )
            sync_service.push_episode_role_unassignment(ep_id, role, db)
        return None

    if old_device_id == body.device_id:
        return existing  # no actual change

    if existing:
        existing.device_id = body.device_id
        existing.display_name = body.display_name or body.device_id
    else:
        existing = EpisodeRoleAssignment(
            episode_id=ep_id, role=role, device_id=body.device_id, display_name=body.display_name or body.device_id,
        )
        db.add(existing)
    db.commit()
    db.refresh(existing)

    if old_device_id:
        discovery_service.notify_device(
            old_device_id,
            f"Тебе замінено на {existing.display_name} у ролі «{role}» для серії {ep.number} ({title.name_ua}).",
        )
    discovery_service.notify_device(
        body.device_id,
        f"Тебе призначено на роль «{role}» для серії {ep.number} ({title.name_ua})"
        + (f" (замість {old_name})." if old_name else "."),
    )
    sync_service.push_episode_role_assignment(existing, db)
    return existing


@router.post("/episodes/{ep_id}/remind")
def remind_episode_role(ep_id: int, body: RemindRequest, db: Session = Depends(get_db)):
    """Адмін tab's "Нагадати" button — tells the specific assigned person
    (or actor) how much time is left, or how many days they're overdue."""
    import datetime as dt
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    _require_team_manager_for_episode(ep, db)

    device_id: "str | None" = None
    if body.role == "actor" and body.character_id:
        char = db.get(Character, body.character_id)
        device_id = char.team_device_id if char else None
    else:
        from ..services.sync_service import resolve_role_assignment
        assignment = resolve_role_assignment(body.role, db, episode=ep)
        device_id = assignment.device_id if assignment else None
    if not device_id:
        raise HTTPException(400, "Не призначено нікого на цю роль")

    deadline_row = db.query(EpisodeRoleDeadline).filter(
        EpisodeRoleDeadline.episode_id == ep_id, EpisodeRoleDeadline.role == body.role,
        EpisodeRoleDeadline.character_id == body.character_id,
    ).first()
    now = dt.datetime.utcnow()
    if deadline_row and deadline_row.deadline:
        if now > deadline_row.deadline:
            days_late = max(1, (now - deadline_row.deadline).days)
            time_note = f"Дедлайн прострочено на {days_late} дн."
        else:
            left = deadline_row.deadline - now
            time_note = f"Залишилось часу: {left.days} дн. {left.seconds // 3600} год."
    else:
        time_note = "Дедлайн не встановлено."
    title = db.get(Title, ep.title_id)
    message = f"Нагадування: {title.name_ua if title else '?'} — серія {ep.number}. {time_note}"
    from ..services import discovery_service
    sent = discovery_service.notify_device(device_id, message)
    return {"sent": bool(sent)}


@router.get("/episodes/{ep_id}/admin-status", response_model=List[EpisodeAdminPersonStatus])
def get_episode_admin_status(ep_id: int, db: Session = Depends(get_db)):
    """Powers the "Адмін" tab's per-person production-status readout — see
    the feature plan's status rules. Actors are returned first, then the
    singular roles (director/translator/sound_engineer/...)."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    title = db.get(Title, ep.title_id)
    result: list[EpisodeAdminPersonStatus] = []

    deadlines = {
        (d.role, d.character_id): d.deadline
        for d in db.query(EpisodeRoleDeadline).filter(EpisodeRoleDeadline.episode_id == ep_id).all()
    }

    # Actors — the whole cast of the TITLE (any Character with a real team
    # actor linked), not just whoever already has lines/markers/audio in
    # THIS episode. Restricting to "already has content here" (the
    # original design) meant a deadline could only ever be set AFTER an
    # actor had already started — useless for the actual use case of
    # assigning deadlines to the whole cast up front, before anyone's
    # touched the episode yet (confirmed live 2026-09-08). A cast member
    # with nothing submitted yet just reads status=None, same as "не
    # почав" everywhere else in this endpoint.
    chars = db.query(Character).filter(
        Character.title_id == title.id, Character.team_device_id.isnot(None),
        Character.team_device_id != "everyone",
    ).all()
    for char in chars:
        latest = (
            db.query(ActorAudioSubmission)
            .filter(ActorAudioSubmission.episode_id == ep_id, ActorAudioSubmission.character_id == char.id)
            .order_by(ActorAudioSubmission.created_at.desc())
            .first()
        )
        status = None
        if latest:
            if latest.sent_to_sound_engineer_at:
                status = "готово"
            elif latest.fix_requested_at:
                status = "фікси"
            else:
                status = "на перевірці"
        result.append(EpisodeAdminPersonStatus(
            role="actor", character_id=char.id, character_name=char.name,
            device_id=char.team_device_id, display_name=char.name, status=status,
            deadline=deadlines.get(("actor", char.id)),
        ))

    from ..services.sync_service import resolve_role_assignment

    def _person(role: str) -> "TitleRoleAssignment | EpisodeRoleAssignment | None":
        return resolve_role_assignment(role, db, episode=ep, title=title)

    # Translator
    tr = _person("translator")
    if ep.subtitle_stage == "translating" and not ep.translation_started_at:
        tr_status = "не взявся"
    elif ep.subtitle_stage == "translating":
        tr_status = "взявся"
    elif ep.subtitle_stage == "ready_for_director":
        tr_status = "на режисурі"
    else:
        tr_status = "готово"
    result.append(EpisodeAdminPersonStatus(
        role="translator", device_id=tr.device_id if tr else None, display_name=tr.display_name if tr else None,
        status=tr_status, deadline=deadlines.get(("translator", None)),
    ))

    # Director
    di = _person("director")
    audio_total = db.query(ActorAudioSubmission).filter(ActorAudioSubmission.episode_id == ep_id).count()
    audio_forwarded = db.query(ActorAudioSubmission).filter(
        ActorAudioSubmission.episode_id == ep_id, ActorAudioSubmission.sent_to_sound_engineer_at.isnot(None),
    ).count()
    if ep.subtitle_stage == "translating":
        di_status = "чекає субтитри"
    elif ep.subtitle_stage == "ready_for_director":
        di_status = "режисирує субтитри"
    elif audio_total == 0:
        di_status = "субтитри готові"
    elif audio_forwarded == audio_total:
        di_status = "готово"
    else:
        di_status = "режисирує голос"
    marker_count = db.query(Marker).filter(Marker.episode_id == ep_id, Marker.confirmed.is_(True)).count()
    result.append(EpisodeAdminPersonStatus(
        role="director", device_id=di.device_id if di else None, display_name=di.display_name if di else None,
        status=di_status,
        badges={"субтитри": ep.subtitle_stage == "ready_for_actors", "маркери": marker_count > 0},
        deadline=deadlines.get(("director", None)),
    ))

    # Sound engineer
    se = _person("sound_engineer")
    se_status = None
    se_progress = None
    if audio_forwarded > 0:
        se_progress = f"{audio_forwarded}/{audio_total}"
        se_status = "готово" if ep.sound_engineer_done_at else None
    result.append(EpisodeAdminPersonStatus(
        role="sound_engineer", device_id=se.device_id if se else None, display_name=se.display_name if se else None,
        status=se_status, progress=se_progress, deadline=deadlines.get(("sound_engineer", None)),
    ))

    # Cleaner (клінапер) — bespoke status based on the uploaded cleaned
    # video, same "готово"/waiting shape as the other singular roles.
    cl = _person("cleaner")
    result.append(EpisodeAdminPersonStatus(
        role="cleaner", device_id=cl.device_id if cl else None, display_name=cl.display_name if cl else None,
        status="завантажено" if ep.cleaned_video_transfer_id else "очікує",
        deadline=deadlines.get(("cleaner", None)),
    ))

    # Any other custom RoleCatalog role — assignment/deadline/remind still
    # work, just no bespoke status text.
    other_roles = [
        r.key for r in db.query(RoleCatalog).all()
        if r.key not in ("actor", "translator", "director", "sound_engineer", "cleaner")
    ]
    for role in other_roles:
        p = _person(role)
        if not p and (role, None) not in deadlines:
            continue
        result.append(EpisodeAdminPersonStatus(
            role=role, device_id=p.device_id if p else None, display_name=p.display_name if p else None,
            status=None, deadline=deadlines.get((role, None)),
        ))

    return result
