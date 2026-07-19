import os

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db, DATA_DIR
from ..models import AppSettings, Episode, Profile
from ..schemas import AppSettingsOut, AppSettingsUpdate, CacheInfoOut, ProfileOut
from ..services.separator_service import MODEL_MAP

router = APIRouter(tags=["settings"])

# The "cache" is the set of auto-generated 480p preview proxies (one per episode).
# It is separate from the lossless audio/vocal stems and never touches the original video.
DEFAULT_CACHE_DIR = os.path.join(DATA_DIR, "episodes")


def _get_or_create(db: Session) -> AppSettings:
    row = db.get(AppSettings, 1)
    if not row:
        row = AppSettings(id=1, cache_dir=DEFAULT_CACHE_DIR)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _to_out(row: AppSettings, db: Session) -> AppSettingsOut:
    out = AppSettingsOut.model_validate(row)
    out.available_models = list(MODEL_MAP.keys())
    out.cache_dir = row.cache_dir or DEFAULT_CACHE_DIR
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


def _proxy_paths(db: Session) -> list[str]:
    rows = db.query(Episode.proxy_480p_path).filter(Episode.proxy_480p_path.isnot(None)).all()
    return [r[0] for r in rows if r[0] and os.path.isfile(r[0])]


@router.get("/settings/cache-info", response_model=CacheInfoOut)
def cache_info(db: Session = Depends(get_db)):
    row = _get_or_create(db)
    paths = _proxy_paths(db)
    size_bytes = sum(os.path.getsize(p) for p in paths)
    return CacheInfoOut(
        cache_dir=row.cache_dir or DEFAULT_CACHE_DIR,
        size_bytes=size_bytes,
        size_label=_format_size(size_bytes),
        file_count=len(paths),
    )


@router.post("/settings/cache/clear", response_model=CacheInfoOut)
def clear_cache(db: Session = Depends(get_db)):
    row = _get_or_create(db)
    # Only remove the generated 480p proxies — original video and audio/vocal stems
    # are untouched. Episodes will regenerate their proxy on next open/import.
    for ep in db.query(Episode).filter(Episode.proxy_480p_path.isnot(None)).all():
        if ep.proxy_480p_path and os.path.isfile(ep.proxy_480p_path):
            os.remove(ep.proxy_480p_path)
        ep.proxy_480p_path = None
    db.commit()
    return CacheInfoOut(cache_dir=row.cache_dir or DEFAULT_CACHE_DIR, size_bytes=0, size_label=_format_size(0), file_count=0)


def _format_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} Б"
    size = float(size_bytes)
    for unit in ("КБ", "МБ", "ГБ", "ТБ"):
        size /= 1024
        if size < 1024 or unit == "ТБ":
            return f"{size:.1f} {unit}".replace(".", ",")
