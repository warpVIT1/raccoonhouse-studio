"""
Actor audio submissions — "Здати" button in ActorWorkspace.tsx. An actor
picks however many recorded audio files they want and uploads each one,
no per-line/marker slicing on their end at all (that's the sound
engineer's job in Reaper, using the marker CSV/reascript export already
built — see reaper_exporter.py). Uploaded to the same R2 transfer relay
everything else here uses (rh-team- prefix, same 14-day lifecycle rule as
the actor-video handoff), tracked as ActorAudioSubmission rows so the
sound engineer's own workspace can list/download them per episode.
"""
import os
import uuid
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import ActorAudioSubmission, Character, Episode, Title
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from . import discovery_service
from .power_share_service import app_logger, _ProgressFile


def run_submit_actor_audio(
    episode_id: int, file_path: str, character_id: "int | None",
    uploaded_by_device_id: "str | None", uploaded_by_name: str,
    reporter: ProgressReporter, fix_of_submission_id: "int | None" = None,
) -> dict:
    db = SessionLocal()
    try:
        return _run_submit_actor_audio(
            episode_id, file_path, character_id, uploaded_by_device_id, uploaded_by_name, reporter, db,
            fix_of_submission_id,
        )
    finally:
        db.close()


def _run_submit_actor_audio(
    episode_id: int, file_path: str, character_id: "int | None",
    uploaded_by_device_id: "str | None", uploaded_by_name: str,
    reporter: ProgressReporter, db: Session, fix_of_submission_id: "int | None" = None,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")
    if not os.path.isfile(file_path):
        raise ValueError(f"Audio file not found: {file_path}")

    filename = Path(file_path).name
    size = os.path.getsize(file_path)
    # No dot before the extension letters — the Worker's own /transfer/:id
    # and /transfer/:id/multipart routes match the id with [A-Za-z0-9_-]+,
    # which excludes ".". A transfer_id containing a literal dot (as this
    # used to build with e.g. "...abcd1234.flac") never matches ANY of
    # those routes and falls through to the Worker's WebSocket-signaling
    # fallback, which replies "426 Client Error: Upgrade Required" — not a
    # network/streaming issue at all, 100% reproducible for every audio
    # submission (confirmed live 2026-09-08: video transfer_ids never had
    # an extension suffix and never hit this, only actor-audio and cleaned-
    # video did). The real filename (with its real extension) is already
    # carried separately via ActorAudioSubmission.filename and the
    # ?filename= query param on download — the transfer_id never needed
    # the dot at all, just an opaque storage key.
    ext = (Path(file_path).suffix or ".wav").lstrip(".")
    transfer_id = f"rh-team-actoraudio-{episode_id}-{uuid.uuid4().hex}{ext}"

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

    submission = ActorAudioSubmission(
        episode_id=episode_id, character_id=character_id, filename=filename,
        transfer_id=transfer_id, uploaded_by_device_id=uploaded_by_device_id,
        uploaded_by_name=uploaded_by_name, fix_of_submission_id=fix_of_submission_id,
    )
    db.add(submission)
    db.commit()
    db.refresh(submission)

    if ep.title.shared_id:
        from .sync_service import push_actor_audio_submission
        push_actor_audio_submission(submission.id, db)

    char_name = None
    if character_id:
        char = db.get(Character, character_id)
        char_name = char.name if char else None
    title = db.get(Title, ep.title_id)
    label = f"{title.name_ua if title else '?'} — серія {ep.number}"
    who = f"{uploaded_by_name} ({char_name})" if char_name else uploaded_by_name
    if title:
        from .sync_service import notify_role_for_title, check_and_notify_late
        # A fix re-take goes back to whichever role actually asked for it
        # (director or sound engineer — see ActorAudioSubmission.
        # fix_requested_by_role on the ORIGINAL submission), not always the
        # director — the sound engineer's own "Звук" tab can request fixes
        # too (see EpisodeWorkspace.tsx), and should be the one to know a
        # correction landed rather than relying on the director to relay it.
        notify_role = "director"
        if fix_of_submission_id:
            original = db.get(ActorAudioSubmission, fix_of_submission_id)
            if original and original.fix_requested_by_role:
                notify_role = original.fix_requested_by_role
        verb = "здав виправлену доріжку" if fix_of_submission_id else "здав звукову доріжку"
        notify_role_for_title(
            title, notify_role, f"{who} {verb}: {filename} ({label})",
            discovery_service.notify_director if notify_role == "director" else discovery_service.notify_sound_engineer,
            db, episode=ep,
        )
        check_and_notify_late(ep, "actor", character_id, who, f"звукова доріжка ({filename})", db)

    reporter.update(100, "Здано")
    app_logger.info(
        "submit_actor_audio: episode=%s character=%s file=%s size=%s",
        episode_id, character_id, filename, size,
    )
    return {"submission_id": submission.id, "transfer_id": transfer_id}
