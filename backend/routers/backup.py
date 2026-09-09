from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..services import backup_service

router = APIRouter(prefix="/backup", tags=["backup"])


@router.post("/create")
def create_backup(db: Session = Depends(get_db)):
    # Called by electron/main.ts's before-quit handler right before an
    # update installs — {"ok": False, ...} lets the user choose to skip
    # the backup and proceed anyway rather than blocking the update.
    return backup_service.estimate_and_create_backup(db)


@router.get("/status")
def get_backup_status():
    # The actual restore already ran synchronously during init_db(), before
    # the HTTP server started listening — this just reports what happened,
    # for a one-off toast on the renderer's first load after an update.
    return backup_service.get_last_restore_result() or {"titles_restored": 0}
