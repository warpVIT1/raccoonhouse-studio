import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import job_manager
from ..database import SessionLocal, get_db
from ..models import AppSettings, Profile
from ..schemas import (
    AdminUnlockRequest,
    AppSettingsOut,
    AppSettingsUpdate,
    AudioSeparatorVersionIn,
    ProfileOut,
)
from ..services import device_identity_service, gpu_runtime_service, lib_runtime_service, team_service
from ..services.separator_service import MODEL_MAP

router = APIRouter(tags=["settings"])

# Deliberately trivial and hardcoded — this is a convenience gate for a
# closed trusted circle (see Profile.is_admin's comment), not real security.
# Change here if the password ever needs to change; no config UI for it
# since there's exactly one person who's meant to know it.
ADMIN_PASSWORD = "0"


def _get_or_create(db: Session) -> AppSettings:
    row = db.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _to_out(row: AppSettings, db: Session) -> AppSettingsOut:
    out = AppSettingsOut.model_validate(row)
    out.available_models = list(MODEL_MAP.keys())
    out.gpu_available = gpu_runtime_service.has_nvidia_gpu()
    out.gpu_runtime_installed = (
        gpu_runtime_service.is_gpu_runtime_installed() and gpu_runtime_service.is_torch_cuda_installed()
    )
    out.audio_separator_version = lib_runtime_service.active_version()
    update = lib_runtime_service.update_available()
    out.audio_separator_update_version = update["version"] if update else None
    if row.active_profile_id:
        profile = db.get(Profile, row.active_profile_id)
        if profile:
            out.active_profile = ProfileOut.model_validate(profile)
            # The owner's telegram_id always counts as admin even if the
            # stored flag says otherwise (see team_service.is_admin_profile's
            # own comment) — without this override here, the UI itself would
            # hide every admin-only tab/control despite the backend already
            # granting the actual permission, which is worse than useless.
            out.active_profile.is_admin = team_service.is_admin_profile(profile)
        else:
            out.active_profile = None
        # Profile-scoped, not the bare machine id — this is what actually
        # matters for team invites (see device_identity_service.get_profile_id's
        # comment: different local profiles on one shared PC need different
        # ids). Falls back to the bare machine id with no active profile at
        # all, so Settings still shows *something* rather than blank.
        out.device_id = device_identity_service.get_profile_id(profile.name) if profile else device_identity_service.get_device_id()
    else:
        out.device_id = device_identity_service.get_device_id()
    return out


@router.get("/settings", response_model=AppSettingsOut)
def get_settings(db: Session = Depends(get_db)):
    return _to_out(_get_or_create(db), db)


@router.put("/settings", response_model=AppSettingsOut)
def update_settings(body: AppSettingsUpdate, db: Session = Depends(get_db)):
    row = _get_or_create(db)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)
    db.commit()
    db.refresh(row)
    return _to_out(row, db)


def _install_gpu_runtime_job(reporter):
    # Two independent downloads: onnxruntime's CUDA provider (MDX-Net) and
    # torch/torchvision's CUDA build (VR Arch, Demucs, MDX23C, BS-RoFormer).
    # Weighted roughly by their actual sizes (~2.8GB / ~2.5GB) so the combined
    # progress bar doesn't jump unevenly. Each is skipped if already present,
    # so retrying after a partial failure doesn't re-download what worked.
    if not gpu_runtime_service.is_gpu_runtime_installed():
        gpu_runtime_service.install_gpu_runtime(on_progress=lambda p, m: reporter.update(int(p * 0.53), m))
    if not gpu_runtime_service.is_torch_cuda_installed():
        gpu_runtime_service.install_torch_cuda(on_progress=lambda p, m: reporter.update(53 + int(p * 0.47), m))
    # Own DB session, not the request's — this runs in a background thread
    # pool that outlives the HTTP request (same reasoning as run_separation
    # in separator_service.py).
    db = SessionLocal()
    try:
        row = _get_or_create(db)
        row.gpu_enabled = True
        db.commit()
    finally:
        db.close()


@router.post("/settings/verify-admin-password")
def verify_admin_password(body: AdminUnlockRequest):
    # Stateless on purpose — this only checks the password; ProfileModal
    # applies is_admin=True to the specific profile being created/activated
    # via the normal /profiles endpoints, not here (see Profile.is_admin's
    # comment for why it lives per-profile rather than as a single
    # install-wide flag on AppSettings).
    if body.password != ADMIN_PASSWORD:
        raise HTTPException(400, "Невірний пароль")
    return {"ok": True}


@router.post("/settings/install-gpu-runtime")
async def install_gpu_runtime_endpoint():
    if not gpu_runtime_service.has_nvidia_gpu():
        raise HTTPException(400, "NVIDIA GPU не знайдено на цьому комп'ютері")
    if gpu_runtime_service.is_gpu_runtime_installed() and gpu_runtime_service.is_torch_cuda_installed():
        raise HTTPException(400, "GPU-прискорення вже встановлено")

    job = job_manager.create_job("install_gpu_runtime")
    loop = asyncio.get_event_loop()
    asyncio.create_task(job_manager.run_job(loop, job, _install_gpu_runtime_job))
    return {"job_id": job.id}


def _install_audio_separator_update_job(update: dict):
    def run(reporter):
        lib_runtime_service.install_version(
            update["version"], update["wheel_url"], on_progress=lambda p, m: reporter.update(p, m)
        )
    return run


@router.post("/settings/install-audio-separator-update")
async def install_audio_separator_update_endpoint():
    update = lib_runtime_service.update_available()
    if not update:
        raise HTTPException(400, "Немає доступного оновлення audio-separator")

    job = job_manager.create_job("install_audio_separator_update")
    loop = asyncio.get_event_loop()
    asyncio.create_task(job_manager.run_job(loop, job, _install_audio_separator_update_job(update)))
    return {"job_id": job.id}


@router.put("/settings/audio-separator-version")
def publish_audio_separator_version(body: AudioSeparatorVersionIn, db: Session = Depends(get_db)):
    # Admin-only: this bumps the RECOMMENDED version for the whole studio,
    # not just this install's own — see lib_runtime_service.push_recommended_version.
    settings = _get_or_create(db)
    profile = db.get(Profile, settings.active_profile_id) if settings.active_profile_id else None
    if not team_service.is_admin_profile(profile):
        raise HTTPException(403, "Лише адмін може публікувати версію audio-separator")
    try:
        lib_runtime_service.push_recommended_version(body.version, body.wheel_url)
    except Exception as e:
        raise HTTPException(502, f"Не вдалося опублікувати: {e}")
    return {"ok": True}


def _active_profile_name(db: Session) -> "str | None":
    settings = _get_or_create(db)
    profile = db.get(Profile, settings.active_profile_id) if settings.active_profile_id else None
    return profile.name if profile else None


@router.get("/settings/notifications-paused")
def get_notifications_paused_endpoint():
    try:
        return {"paused": team_service.get_notifications_paused()}
    except Exception:
        raise HTTPException(502, "Не вдалося отримати статус сповіщень")


@router.put("/settings/notifications-paused")
def set_notifications_paused_endpoint(body: dict, db: Session = Depends(get_db)):
    profile_name = _active_profile_name(db)
    if not profile_name:
        raise HTTPException(400, "Немає активного профілю")
    try:
        return team_service.set_notifications_paused(bool(body.get("paused")), profile_name)
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception:
        raise HTTPException(502, "Не вдалося змінити статус сповіщень")
