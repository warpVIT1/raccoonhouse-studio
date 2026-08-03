import asyncio

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import job_manager
from ..database import SessionLocal, get_db
from ..models import AppSettings, Profile
from ..schemas import AdminUnlockRequest, AppSettingsOut, AppSettingsUpdate, ProfileOut
from ..services import gpu_runtime_service
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
    if row.active_profile_id:
        profile = db.get(Profile, row.active_profile_id)
        out.active_profile = ProfileOut.model_validate(profile) if profile else None
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
