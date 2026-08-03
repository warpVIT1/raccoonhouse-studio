from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, Profile
from ..schemas import FeedbackCreate, FeedbackOut
from ..services import discovery_service

router = APIRouter(prefix="/feedback", tags=["feedback"])


def _active_nickname(db: Session) -> str:
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id:
        profile = db.get(Profile, settings.active_profile_id)
        if profile and profile.name.strip():
            return profile.name.strip()
    return "Анонім"


@router.post("", status_code=201)
def send_feedback(body: FeedbackCreate, db: Session = Depends(get_db)):
    message = body.message.strip()
    if not message:
        raise HTTPException(400, "Повідомлення не може бути порожнім")
    try:
        feedback_id = discovery_service.submit_feedback(_active_nickname(db), message)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(502, "Не вдалося надіслати — перевірте з'єднання")
    return {"id": feedback_id}


@router.get("", response_model=list[FeedbackOut])
def get_feedback():
    try:
        return discovery_service.list_feedback()
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(502, "Не вдалося отримати список — перевірте з'єднання")


@router.delete("/{feedback_id}", status_code=204)
def dismiss_feedback(feedback_id: str):
    discovery_service.delete_feedback(feedback_id)
