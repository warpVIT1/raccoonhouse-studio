"""
Клінапер's uploaded result — the "cleaned" (on-screen text/signs erased)
video handed off after they finish, one per episode (unlike
ActorAudioSubmission's many-per-episode shape — a re-upload here replaces
the previous one, there's only ever one current cleaned video). Uploaded to
the same R2 transfer relay everything else here uses; see
ActorAudioSubmission's own upload flow (actor_audio_service.py) for the
identical progress-reporting pattern this mirrors.
"""
import os
import uuid
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import Episode, Title
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from . import discovery_service
from .power_share_service import app_logger, _ProgressFile


def run_submit_cleaned_video(episode_id: int, file_path: str, reporter: ProgressReporter) -> dict:
    db = SessionLocal()
    try:
        return _run_submit_cleaned_video(episode_id, file_path, reporter, db)
    finally:
        db.close()


def _run_submit_cleaned_video(episode_id: int, file_path: str, reporter: ProgressReporter, db: Session) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")
    if not os.path.isfile(file_path):
        raise ValueError(f"Video file not found: {file_path}")

    filename = Path(file_path).name
    size = os.path.getsize(file_path)
    # No dot before the extension letters — see actor_audio_service.py's
    # identical fix for why a literal "." in transfer_id breaks every
    # /transfer/:id route match on the Worker side (426 "Upgrade Required").
    ext = (Path(file_path).suffix or ".mp4").lstrip(".")
    old_transfer_id = ep.cleaned_video_transfer_id
    transfer_id = f"rh-team-cleanedvideo-{episode_id}-{uuid.uuid4().hex}{ext}"

    reporter.update(2, "Завантажую…")
    progress_file = _ProgressFile(
        file_path, size,
        on_progress=lambda pct: reporter.update(pct, "Завантажую…"),
        pct_lo=2, pct_hi=95,
    )
    try:
        discovery_service.upload_transfer(transfer_id, progress_file, size)
    finally:
        progress_file.close()

    import datetime as dt
    ep.cleaned_video_transfer_id = transfer_id
    ep.cleaned_video_filename = filename
    ep.cleaned_video_uploaded_at = dt.datetime.utcnow()
    db.commit()
    # This class's own docstring already says "a re-upload here replaces
    # the previous one" — true for the DB pointer, but confirmed live
    # 2026-09-09 the old R2 object itself was never deleted, silently
    # orphaned on every re-upload (same bug as sync_service._push_episode_video).
    if old_transfer_id and old_transfer_id != transfer_id:
        discovery_service.delete_transfer(old_transfer_id)

    title = db.get(Title, ep.title_id)
    if title and title.shared_id:
        from .sync_service import push_cleaned_video_transfer_id, notify_role_for_title
        push_cleaned_video_transfer_id(episode_id, db)
        label = f"{title.name_ua} — серія {ep.number}"
        notify_role_for_title(
            title, "director", f"Клінапер завантажив заклінапене відео: {filename} ({label})",
            discovery_service.notify_director, db, episode=ep,
        )

    reporter.update(100, "Завантажено")
    app_logger.info("submit_cleaned_video: episode=%s file=%s size=%s", episode_id, filename, size)
    return {"transfer_id": transfer_id}
