from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, Profile
from ..schemas import AppSettingsOut, AppSettingsUpdate, ProfileOut
from ..services.separator_service import MODEL_MAP

router = APIRouter(tags=["settings"])


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
