from fastapi import APIRouter, HTTPException

from ..schemas import SeparationReportOut
from ..services import discovery_service

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("", response_model=list[SeparationReportOut])
def get_reports():
    try:
        return discovery_service.list_reports()
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(502, "Не вдалося отримати список — перевірте з'єднання")


@router.delete("/{report_id}", status_code=204)
def dismiss_report(report_id: str):
    discovery_service.delete_report(report_id)
