import asyncio
import re
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from .. import job_manager
from ..database import get_db
from ..models import ActorAudioFixMarker, ActorAudioSubmission, AppSettings, Character, Episode, Profile, Title
from ..schemas import (
    ActorAudioFixMarkerImportRequest, ActorAudioFixMarkerOut, ActorAudioSubmissionOut,
    ActorAudioSubmitRequest, ActorAudioFixRequest, ActorAudioSendToSoundEngineerRequest,
)

router = APIRouter(tags=["actor-audio"])

# Sound engineer's own custom naming, see AppSettings.sound_engineer_
# filename_template's own comment — placeholders can appear in any order,
# any number of times, or not at all.
_FILENAME_PLACEHOLDERS = {
    "&title": lambda title, ep, char_name, uploader_name: title.name_ua if title else "",
    "&series": lambda title, ep, char_name, uploader_name: f"S{ep.season:02d}" if ep else "",
    "&episode": lambda title, ep, char_name, uploader_name: f"E{ep.number:02d}" if ep else "",
    "&character": lambda title, ep, char_name, uploader_name: char_name or "",
    "&actor": lambda title, ep, char_name, uploader_name: uploader_name or "",
}


def _format_audio_filename(
    template: str, original_filename: str, title: "Title | None", ep: "Episode | None",
    char_name: "str | None", uploader_name: str,
) -> str:
    ext = Path(original_filename).suffix or ".wav"
    stem = template
    for placeholder, resolve in _FILENAME_PLACEHOLDERS.items():
        stem = stem.replace(placeholder, resolve(title, ep, char_name, uploader_name))
    stem = re.sub(r'[\\/:*?"<>|]', "_", stem).strip(" _") or "audio"
    return f"{stem}{ext}"


def _active_profile(db: Session) -> "Profile | None":
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id:
        return db.get(Profile, settings.active_profile_id)
    return None


@router.post("/episodes/{ep_id}/actor-audio")
async def submit_actor_audio(ep_id: int, body: ActorAudioSubmitRequest, db: Session = Depends(get_db)):
    """"Здати" — an actor uploads however many recorded audio files they
    want for this episode, no per-line slicing (that's the sound
    engineer's job in Reaper — see reaper_exporter.py's marker export).
    Job-based like the actor-video export, since a WAV recording can be
    hundreds of MB. Must be async — asyncio.get_event_loop() below needs
    the main event-loop thread, not the worker-thread pool a plain `def`
    endpoint runs in (confirmed live 2026-08-20: every "Здати" click 500'd
    with "no current event loop in thread 'AnyIO worker thread'")."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404, "Episode not found")

    profile = _active_profile(db)
    uploaded_by_name = profile.name if profile else "?"
    device_id = None
    if profile:
        from ..services import device_identity_service
        device_id = device_identity_service.get_profile_id(profile.name)

    job = job_manager.create_job("submit_actor_audio", episode_id=ep_id)
    from ..services.actor_audio_service import run_submit_actor_audio
    loop = asyncio.get_event_loop()
    asyncio.create_task(
        job_manager.run_job(loop, job, lambda r: run_submit_actor_audio(
            ep_id, body.file_path, body.character_id, device_id, uploaded_by_name, r,
            body.fix_of_submission_id,
        ))
    )
    return {"job_id": job.id}


@router.get("/episodes/{ep_id}/actor-audio", response_model=List[ActorAudioSubmissionOut])
def list_actor_audio(ep_id: int, db: Session = Depends(get_db)):
    """Sound engineer's "Звукові доріжки" tab (see EpisodeWorkspace.tsx) —
    only shown at all once this list is non-empty."""
    submissions = (
        db.query(ActorAudioSubmission)
        .filter(ActorAudioSubmission.episode_id == ep_id)
        .order_by(ActorAudioSubmission.created_at.desc())
        .all()
    )
    result = []
    for s in submissions:
        out = ActorAudioSubmissionOut.model_validate(s)
        if s.character_id:
            char = db.get(Character, s.character_id)
            out.character_name = char.name if char else None
        out.fix_marker_count = len(s.fix_markers)
        result.append(out)
    return result


@router.get("/episodes/{ep_id}/actor-audio/{submission_id}/url")
def get_actor_audio_url(ep_id: int, submission_id: int, db: Session = Depends(get_db)):
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    from urllib.parse import quote
    from ..services import discovery_service
    base = discovery_service.get_https_base()
    if not base:
        raise HTTPException(400, "Онлайн-сигналізація не налаштована")

    # Without ?filename=, the Worker's /transfer/:id route has no
    # Content-Type/Content-Disposition for this transfer_id shape at all
    # (confirmed live 2026-08-19) — the browser saves it as an extension-
    # less blob named after the raw R2 key, not the actor's real filename.
    # Same fix pattern as actor_video_service._build_video_filename.
    filename = submission.filename

    # Sound engineer's own custom template applies ONLY when the currently
    # active profile actually holds that role — the director's own
    # download always gets the untouched original filename regardless of
    # what's configured (see AppSettings.sound_engineer_filename_template's
    # own comment for why this is gated by role, not just "whoever asks").
    profile = _active_profile(db)
    settings = db.get(AppSettings, 1)
    template = settings.sound_engineer_filename_template if settings else None
    if template and profile and profile.roles and "sound_engineer" in profile.roles:
        ep = db.get(Episode, ep_id)
        title = db.get(Title, ep.title_id) if ep else None
        char_name = None
        if submission.character_id:
            char = db.get(Character, submission.character_id)
            char_name = char.name if char else None
        filename = _format_audio_filename(template, submission.filename, title, ep, char_name, submission.uploaded_by_name)

    return {"url": f"{base}/transfer/{submission.transfer_id}?filename={quote(filename)}"}


@router.post("/episodes/{ep_id}/actor-audio/{submission_id}/request-fix")
def request_actor_audio_fix(ep_id: int, submission_id: int, body: ActorAudioFixRequest, db: Session = Depends(get_db)):
    """A per-track note that goes straight to the actor who submitted it
    (uploaded_by_device_id, captured at upload time — see
    actor_audio_service.py), not a broad role broadcast. Called from BOTH
    the director's and the sound engineer's own "Звук" tab — `from_role`
    (set by whichever frontend calls this) is what makes the Telegram text
    correctly say who actually sent it, and what drives the "фікси" status
    in the Адмін tab (see ActorAudioSubmission.fix_requested_by_role).
    Best-effort like every other Telegram notify in this app.

    THE single place a fix actually goes out — a director can write text,
    attach a marker CSV, or both, and it's all one "Відправити" click on
    the frontend resulting in exactly one notification here (confirmed live
    2026-09-08: importing markers and sending text used to each fire their
    own separate Telegram message the instant either control was touched,
    before the other was even filled in — see import_fix_markers'/
    _replace_fix_markers' own docstrings)."""
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    message = body.message.strip()
    if not message and not body.marker_file_path:
        raise HTTPException(400, "Потрібно написати текст правок або додати маркери")

    marker_count = None
    if body.marker_file_path:
        created = _replace_fix_markers(submission_id, body.marker_file_path, body.bpm, db)
        marker_count = len(created)

    import datetime as dt
    submission.fix_requested_at = dt.datetime.utcnow()
    submission.fix_requested_by_role = body.from_role
    submission.fix_message = message or submission.fix_message
    db.commit()
    if submission.shared_id:
        from ..services.sync_service import push_actor_audio_submission_status, push_actor_audio_fix_markers
        push_actor_audio_submission_status(submission.id, db)
        if marker_count is not None:
            push_actor_audio_fix_markers(submission_id, db)
    if not submission.uploaded_by_device_id:
        return {"sent": False}
    from ..services import discovery_service
    from_label = "Звукорежисер" if body.from_role == "sound_engineer" else "Режисер"
    parts = []
    if message:
        parts.append(message)
    if marker_count:
        parts.append(f"позначено {marker_count} місце(ь) на маркерах — завантажте їх у програмі")
    text = "; ".join(parts) if parts else "перевірте маркери в програмі"
    sent = discovery_service.notify_device(
        submission.uploaded_by_device_id,
        f"{from_label} просить правки по доріжці «{submission.filename}»: {text}",
    )
    return {"sent": bool(sent)}


@router.get("/episodes/{ep_id}/actor-audio/{submission_id}/fix-markers", response_model=List[ActorAudioFixMarkerOut])
def list_fix_markers(ep_id: int, submission_id: int, db: Session = Depends(get_db)):
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    return submission.fix_markers


def _replace_fix_markers(submission_id: int, file_path: str, bpm: float, db: Session) -> list[ActorAudioFixMarker]:
    """Shared CSV-parsing core for fix markers — same shape as routers/
    markers.py's own import_markers_csv (reused directly via
    _time_to_seconds). Used both by the standalone import route below AND
    by request_actor_audio_fix's combined text+markers submit, so a marker
    CSV is never parsed/replaced by two different code paths."""
    import os
    import csv
    import io
    from .markers import _time_to_seconds

    if not os.path.isfile(file_path):
        raise HTTPException(400, f"CSV file not found: {file_path}")
    with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
        raw = f.read()
    reader = csv.reader(io.StringIO(raw))
    rows = list(reader)
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]
    try:
        name_idx = header.index("name")
        start_idx = header.index("start")
    except ValueError:
        raise HTTPException(400, "CSV має містити колонки Name та Start")
    color_idx = header.index("color") if "color" in header else None

    db.query(ActorAudioFixMarker).filter(ActorAudioFixMarker.submission_id == submission_id).delete()
    created: list[ActorAudioFixMarker] = []
    for row in rows[1:]:
        if len(row) <= start_idx or not row[start_idx].strip():
            continue
        name = row[name_idx].strip() if len(row) > name_idx else ""
        color = row[color_idx].strip() if color_idx is not None and len(row) > color_idx and row[color_idx].strip() else None
        if color and not color.startswith("#"):
            color = f"#{color}"
        marker = ActorAudioFixMarker(
            submission_id=submission_id,
            label=name or "ФІКС",
            position_seconds=_time_to_seconds(row[start_idx], bpm=bpm),
            color=color,
        )
        db.add(marker)
        created.append(marker)
    db.commit()
    return created


@router.post("/episodes/{ep_id}/actor-audio/{submission_id}/fix-markers/import", response_model=List[ActorAudioFixMarkerOut])
def import_fix_markers(ep_id: int, submission_id: int, body: ActorAudioFixMarkerImportRequest, db: Session = Depends(get_db)):
    """Standalone marker-only import — kept for direct API use, but the
    "Звук" tab's own UI no longer calls this on file selection (see
    request_actor_audio_fix's own docstring for why: a director attaching
    BOTH a text note and markers used to fire two separate notifications
    the instant each control was touched, before they'd finished writing
    either). No notification here at all now — request_actor_audio_fix is
    the single place a fix actually gets sent to the actor."""
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    created = _replace_fix_markers(submission_id, body.file_path, body.bpm, db)
    if submission.shared_id:
        from ..services.sync_service import push_actor_audio_fix_markers
        push_actor_audio_fix_markers(submission_id, db)
    return created


@router.get("/episodes/{ep_id}/actor-audio/{submission_id}/fix-markers/export-csv")
def export_fix_markers_csv(ep_id: int, submission_id: int, db: Session = Depends(get_db)):
    """The actor's own side of the round trip — download the fix markers
    back out as the same CSV shape (see reaper_exporter.export_marker_csv)
    so they can import them straight into their own Reaper project to see
    exactly where the retake is needed."""
    import io
    import csv
    from urllib.parse import quote
    from fastapi.responses import StreamingResponse
    from ..services.reaper_exporter import _seconds_to_time

    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["#", "Name", "Start", "End", "Length", "Color"])
    for i, m in enumerate(submission.fix_markers, start=1):
        t = _seconds_to_time(m.position_seconds)
        writer.writerow([i, m.label, t, t, "0:00:00.000", (m.color or "").lstrip("#")])
    filename = f"fix_{submission.filename}.csv"
    ascii_fallback = filename.encode("ascii", "ignore").decode("ascii") or "fix_markers.csv"
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=\"{ascii_fallback}\"; filename*=UTF-8''{quote(filename)}"},
    )


@router.post("/episodes/{ep_id}/actor-audio/{submission_id}/accept")
def accept_actor_audio_fix(ep_id: int, submission_id: int, db: Session = Depends(get_db)):
    """The director's sign-off gate on a fix re-take (see
    ActorAudioSubmission.fix_of_submission_id/accepted_at) — a corrected
    track the actor uploaded in response to a fix request doesn't get
    auto-forwarded; the director explicitly accepts it here (frontend shows
    a confirm dialog first), and ONLY that action stamps
    sent_to_sound_engineer_at, same effect as send_actor_audio_to_sound_
    engineer below but for one already-known submission instead of a
    multi-select batch (first-time, non-fix submissions still use that
    bulk flow)."""
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    import datetime as dt
    now = dt.datetime.utcnow()
    profile = _active_profile(db)
    submission.accepted_at = now
    submission.accepted_by_name = profile.name if profile else "?"
    submission.sent_to_sound_engineer_at = now
    db.commit()
    if submission.shared_id:
        from ..services.sync_service import push_actor_audio_submission_status
        push_actor_audio_submission_status(submission.id, db)

    title = db.get(Title, ep.title_id)
    if title:
        from ..services import discovery_service, sync_service
        sync_service.notify_role_for_title(
            title, "sound_engineer",
            f"Режисер прийняв виправлену доріжку для серії {ep.number}: {submission.filename}",
            discovery_service.notify_sound_engineer, db, episode=ep,
        )
    return {"accepted_at": submission.accepted_at, "sent_to_sound_engineer_at": submission.sent_to_sound_engineer_at}


@router.post("/episodes/{ep_id}/actor-audio/send-to-sound-engineer")
def send_actor_audio_to_sound_engineer(ep_id: int, body: ActorAudioSendToSoundEngineerRequest, db: Session = Depends(get_db)):
    """DirectorWorkspace's "Звук" tab — director multi-selects the tracks
    they've reviewed and are actually ready, and pings the sound engineer
    role once with just that list (instead of the sound engineer picking
    through every raw submission themselves, some of which may be
    duplicates/bad takes the director already ruled out)."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    submissions = (
        db.query(ActorAudioSubmission)
        .filter(ActorAudioSubmission.id.in_(body.submission_ids), ActorAudioSubmission.episode_id == ep_id)
        .all()
    )
    if not submissions:
        return {"sent": False}
    import datetime as dt
    now = dt.datetime.utcnow()
    for s in submissions:
        s.sent_to_sound_engineer_at = now
    db.commit()
    from ..services.sync_service import push_actor_audio_submission_status
    for s in submissions:
        if s.shared_id:
            push_actor_audio_submission_status(s.id, db)

    filenames = "\n".join(f"— {s.filename}" for s in submissions)
    from ..services import discovery_service, sync_service
    title = db.get(Title, ep.title_id)
    sent = None
    if title:
        sent = sync_service.notify_role_for_title(
            title, "sound_engineer",
            f"Режисер відібрав {len(submissions)} доріжок для серії {ep.number}, готові до роботи:\n{filenames}",
            discovery_service.notify_sound_engineer, db, episode=ep,
        )
        # Forwarding to the sound engineer is the director's own
        # completion action for this episode (see the Адмін tab's status
        # rules) — check the director's own deadline here, not the actors'.
        profile = _active_profile(db)
        sync_service.check_and_notify_late(
            ep, "director", None, profile.name if profile else "Режисер", "передача доріжок звукорежисеру", db,
        )
    return {"sent": bool(sent)}


@router.post("/episodes/{ep_id}/actor-audio/sound-engineer-done")
def mark_sound_engineer_done(ep_id: int, db: Session = Depends(get_db)):
    """Sound engineer's "Готово" button in the Адмін tab — only actually
    completable once every submission for this episode has been forwarded
    (sent_to_sound_engineer_at set), enforced here too (not just the
    frontend's disabled state) since this is what flips the episode fully
    green in the director's own status readout as well."""
    ep = db.get(Episode, ep_id)
    if not ep:
        raise HTTPException(404)
    total = db.query(ActorAudioSubmission).filter(ActorAudioSubmission.episode_id == ep_id).count()
    forwarded = db.query(ActorAudioSubmission).filter(
        ActorAudioSubmission.episode_id == ep_id, ActorAudioSubmission.sent_to_sound_engineer_at.isnot(None),
    ).count()
    if total == 0 or forwarded < total:
        raise HTTPException(400, f"Ще не всі доріжки передано ({forwarded}/{total})")
    import datetime as dt
    ep.sound_engineer_done_at = dt.datetime.utcnow()
    db.commit()
    if ep.title.shared_id:
        from ..services.sync_service import push_episode
        push_episode(ep_id, db)
    from ..services import sync_service
    profile = _active_profile(db)
    sync_service.check_and_notify_late(
        ep, "sound_engineer", None, profile.name if profile else "Звукорежисер", "зведення доріжок", db,
    )
    return {"sound_engineer_done_at": ep.sound_engineer_done_at}


@router.delete("/episodes/{ep_id}/actor-audio/{submission_id}", status_code=204)
def delete_actor_audio(ep_id: int, submission_id: int, db: Session = Depends(get_db)):
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or submission.episode_id != ep_id:
        raise HTTPException(404)
    from ..services import discovery_service
    discovery_service.delete_transfer(submission.transfer_id)
    if submission.shared_id:
        from ..services.sync_service import delete_shared_audio_submission
        delete_shared_audio_submission(submission.shared_id)
    db.delete(submission)
    db.commit()
