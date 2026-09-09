from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, Profile
from ..schemas import ErrorReportCreate, ErrorReportOut
from ..services import device_identity_service, discovery_service

router = APIRouter(prefix="/errors", tags=["errors"])


def _active_profile(db: Session) -> "Profile | None":
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id:
        return db.get(Profile, settings.active_profile_id)
    return None


@router.post("", status_code=201)
def send_error_report(body: ErrorReportCreate, db: Session = Depends(get_db)):
    message = body.message.strip()
    if not message:
        raise HTTPException(400, "message не може бути порожнім")
    profile = _active_profile(db)
    profile_name = profile.name.strip() if profile and profile.name.strip() else "Анонім"
    device_id = device_identity_service.get_profile_id(profile.name) if profile else None
    try:
        error_id = discovery_service.submit_error_report(profile_name, message, body.stack, body.context, device_id)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(502, "Не вдалося надіслати — перевірте з'єднання")
    return {"id": error_id}


@router.get("", response_model=list[ErrorReportOut])
def get_error_reports():
    try:
        return discovery_service.list_error_reports()
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(502, "Не вдалося отримати список — перевірте з'єднання")


@router.delete("/{error_id}", status_code=204)
def dismiss_error_report(error_id: str):
    discovery_service.delete_error_report(error_id)
