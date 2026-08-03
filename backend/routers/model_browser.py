import asyncio
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, ModelRating, Profile
from ..schemas import (
    ModelConfirmRequest,
    ModelDownloadRequest,
    ModelRatingIn,
    ModelRatingOut,
    ModelSubmitRequest,
    RegistryEntryOut,
)
from .. import job_manager
from ..services import discovery_service, separator_service

router = APIRouter(prefix="/models", tags=["model-browser"])


def _active_profile(db: Session) -> "Profile | None":
    settings = db.get(AppSettings, 1)
    if not settings or not settings.active_profile_id:
        return None
    return db.get(Profile, settings.active_profile_id)


@router.get("/browse", response_model=list[RegistryEntryOut])
def browse_models(method: str):
    """The FULL audio-separator registry for a method (not just the curated
    MODEL_CHOICES subset used elsewhere) — reuses registry_entries_for_method,
    which already existed for validation but had no dedicated "give me
    everything" frontend consumer until the Model Browser. Community-added
    models (see /catalog below) are a SEPARATE list — they're not in
    audio-separator's registry at all, so they don't belong in this one."""
    if method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {method}")
    return separator_service.registry_entries_for_method(method)


@router.get("/downloaded")
def get_downloaded_models():
    return {"filenames": separator_service.downloaded_model_filenames()}


@router.delete("/downloaded/{filename}")
def delete_downloaded_model(filename: str):
    # Local-only — removes this install's own copy of the file, never the
    # shared catalog entry (see /catalog above for that).
    try:
        separator_service.delete_downloaded_model(filename)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True}


@router.post("/download")
async def start_model_download(body: ModelDownloadRequest):
    # Must be async — asyncio.get_event_loop() below needs to run on the
    # actual event loop thread. A plain `def` endpoint runs in FastAPI's
    # worker thread pool instead (see run_in_threadpool), where there is no
    # running loop at all — confirmed live: RuntimeError('There is no
    # current event loop in thread 'AnyIO worker thread'') on every call,
    # matching the async def used by every other job-starting endpoint
    # (e.g. episodes.py's batch_separate_vocals, subtitles.py's import_ass).
    if body.method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {body.method}")

    loop = asyncio.get_event_loop()

    if body.source == "custom":
        if not (body.label and body.arch and body.download_url):
            raise HTTPException(400, "label, arch і download_url обов'язкові для власної моделі")
        job = job_manager.create_job("download_model")
        method, filename, label, arch, download_url, config_yaml_url = (
            body.method, body.filename, body.label, body.arch, body.download_url, body.config_yaml_url,
        )
        asyncio.create_task(
            job_manager.run_job(loop, job, lambda r: separator_service.download_custom_model(
                method, filename, label, arch, download_url, config_yaml_url, r,
            ))
        )
        return {"job_id": job.id}

    found, _looks_vocal, _stems = separator_service.check_registry_model(body.method, body.filename)
    if not found:
        raise HTTPException(
            400,
            f"Файл '{body.filename}' не знайдено в реєстрі audio-separator для методу {body.method}",
        )

    job = job_manager.create_job("download_model")
    method, filename = body.method, body.filename
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: separator_service.download_model(method, filename, r))
    )
    return {"job_id": job.id}


@router.post("/submit")
def submit_model_url(body: ModelSubmitRequest):
    """Step 1 of "add by URL": hands the repo link to the Worker's
    Workers-AI-backed auto-configure endpoint and returns its PROPOSED
    config — nothing is saved yet. The frontend shows this for the user to
    review/edit (the AI has been observed constructing plausible-but-wrong
    URLs — see download_url_ok/config_yaml_url_ok in the response, which the
    Worker already HEAD-checked) before a separate call to /confirm
    actually commits it to the shared catalog."""
    try:
        return discovery_service.auto_configure_model(body.url)
    except Exception as e:
        raise HTTPException(502, f"Не вдалося проаналізувати посилання: {e}")


@router.post("/confirm")
def confirm_model(body: ModelConfirmRequest, db: Session = Depends(get_db)):
    """Step 2 of "add by URL" — saves a (possibly user-edited) proposal from
    /submit to the shared Model Browser catalog (Cloudflare D1, via the
    Worker), visible to every install in the studio from then on."""
    if body.method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {body.method}")
    if body.arch not in ("mdx", "vr", "demucs", "mdxc"):
        raise HTTPException(400, f"Невідома архітектура: {body.arch}")

    profile = _active_profile(db)
    added_by = profile.name if profile else "Анонім"

    try:
        return discovery_service.add_browsable_model({**body.model_dump(), "added_by": added_by})
    except Exception as e:
        raise HTTPException(502, f"Не вдалося зберегти модель: {e}")


@router.get("/catalog")
def get_catalog(method: "str | None" = None):
    """Community-added models (via /confirm above) — the shared,
    server-side half of the browser's listing; /browse above covers the
    other half (audio-separator's own built-in registry)."""
    return discovery_service.list_browsable_models(method)


@router.delete("/catalog/{model_id}")
def delete_catalog_entry(model_id: str, db: Session = Depends(get_db)):
    # Deletion removes a model from the WHOLE studio's shared catalog, not
    # just this install's view of it. An admin can remove anything (same
    # reasoning as editing Апекс's line-up — one person's mistake shouldn't
    # silently remove something others rely on); anyone else can only remove
    # a model THEY added themselves, checked server-side against the
    # catalog's own added_by field, not whatever the client claims.
    profile = _active_profile(db)
    if not profile:
        raise HTTPException(403, "Оберіть профіль")

    model = discovery_service.get_browsable_model(model_id)
    if not profile.is_admin and (not model or model.get("added_by") != profile.name):
        raise HTTPException(403, "Можна видаляти лише моделі, які додали ви самі")

    discovery_service.delete_browsable_model(model_id)

    # Ratings are keyed by (method, filename), not this catalog row's own
    # id, so they'd otherwise silently outlive the model — a later re-add of
    # the same file would resurrect its old star ratings as if they'd never
    # been deleted (confirmed live as a real report).
    if model:
        discovery_service.delete_model_ratings(model["method"], model["filename"])
        db.query(ModelRating).filter_by(method=model["method"], filename=model["filename"]).delete()
        db.commit()
    return {"ok": True}


@router.get("/ratings", response_model=list[ModelRatingOut])
def get_model_ratings(method: "str | None" = None, db: Session = Depends(get_db)):
    remote = discovery_service.list_model_ratings()
    if remote:
        separator_service.sync_model_ratings_from_remote(db, remote)
    q = db.query(ModelRating)
    if method:
        q = q.filter(ModelRating.method == method)
    return q.all()


@router.post("/ratings", response_model=ModelRatingOut)
def rate_model(body: ModelRatingIn, db: Session = Depends(get_db)):
    if not (1 <= body.rating <= 5):
        raise HTTPException(400, "Оцінка має бути від 1 до 5")
    if body.method not in separator_service.MODEL_CHOICES:
        raise HTTPException(400, f"Невідомий метод: {body.method}")

    profile = _active_profile(db)
    if not profile:
        raise HTTPException(400, "Оберіть профіль, щоб оцінювати моделі")

    row = (
        db.query(ModelRating)
        .filter_by(method=body.method, filename=body.filename, profile_name=profile.name)
        .first()
    )
    if row:
        row.rating = body.rating
        row.created_at = datetime.utcnow()
    else:
        row = ModelRating(method=body.method, filename=body.filename, profile_name=profile.name, rating=body.rating)
        db.add(row)
    db.commit()
    db.refresh(row)

    discovery_service.submit_model_rating({
        "method": row.method,
        "filename": row.filename,
        "profile_name": row.profile_name,
        "rating": row.rating,
    })
    return row
