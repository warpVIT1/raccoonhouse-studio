"""
Shared titles: mirrors a Title (+ its episodes/characters/subtitle-lines,
and eventually raw video — see the plan's staged rollout) into the
Cloudflare Worker's shared_titles/shared_episodes/shared_characters/
shared_subtitle_lines D1 tables (see cloudflare-signaling/schema.sql) so
every team member's local install can pull the same content. A title's
`shared_id`/`team_id` being set is what turns this on for that title and
everything under it — a title created without the "Спільний з командою"
toggle stays exactly as local-only as this app always was before this
feature existed.

Push (local edit -> cloud): each local CRUD endpoint that touches a shared
title's content calls one of the push_* functions here after its own
commit — best-effort, wrapped so a network hiccup never blocks the local
save (same "local write always wins immediately, cloud sync is secondary"
posture as everything else network-dependent in this app, e.g.
notify_director/notify_actors).

Pull (cloud -> local): pull_and_merge() fetches the full current snapshot
for a team and find-or-creates/updates local rows by shared_id. Triggered
from three places (see discovery_service.py): a "shared_content_updated"
relay push (near-immediate), a coarse periodic heartbeat counter (offline
catch-up), and once after a team join/app start.

Conflict handling is last-write-wins by updated_at (the cloud row's own
updated_at, bumped on every push) — no merge. Same trust model as every
other shared table in this app (model catalog, ratings, etc. have no real
conflict resolution either).
"""
import logging
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests
from sqlalchemy.orm import Session

from . import discovery_service, device_identity_service, team_service
from .power_share_service import _ProgressFile
from ..models import (
    ActorAudioFixMarker, ActorAudioSubmission, AppSettings, Character, Episode, EpisodeRoleAssignment,
    EpisodeRoleDeadline, Marker, Profile, SubtitleLine, Title, TitleRoleAssignment,
)

logger = logging.getLogger("raccoonhouse.sync")

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def _team_device_id(profile_name: str) -> str:
    return device_identity_service.get_profile_id(profile_name)


def _active_profile(db: Session) -> Optional[Profile]:
    settings = db.get(AppSettings, 1)
    if not settings or not settings.active_profile_id:
        return None
    return db.get(Profile, settings.active_profile_id)


def _parse_iso(value: "str | None") -> "datetime | None":
    """Pull side's counterpart to `.isoformat()` on the push side — used
    for every new datetime-valued field synced since 2026-08-19 (role
    deadlines, fix-request/forward timestamps)."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _notify_team(team_id: str, device_id: str) -> None:
    base = discovery_service.get_https_base()
    if not base:
        return
    try:
        requests.post(f"{base}/notify-team-content", json={"team_device_id": device_id, "team_id": team_id}, timeout=15)
    except Exception:
        pass  # best-effort — the periodic/on-reconnect pull fallback in pull_and_merge covers this


def resolve_role_assignment(role: str, db: Session, *, episode: "Episode | None" = None, title: "Title | None" = None):
    """Who's actually assigned to `role` right now — an episode-level
    EpisodeRoleAssignment override takes priority over the title-wide
    TitleRoleAssignment default. Pass `episode` when you have one (the
    common case, since almost every caller is acting on a specific
    episode); `title` alone still works for title-only contexts (e.g. the
    "Команда тайтлу" panel itself, which has no episode to override)."""
    if episode is not None:
        override = db.query(EpisodeRoleAssignment).filter(
            EpisodeRoleAssignment.episode_id == episode.id, EpisodeRoleAssignment.role == role,
        ).first()
        if override:
            return override
        title = title or episode.title
    if title is not None:
        return db.query(TitleRoleAssignment).filter(
            TitleRoleAssignment.title_id == title.id, TitleRoleAssignment.role == role,
        ).first()
    return None


def notify_role_for_title(
    title: Title, role: str, message: str, fallback_broadcast_fn, db: Session, *, episode: "Episode | None" = None,
) -> "int | None":
    """Redirects a stage-handoff notification to whoever is actually
    assigned to `role` (an episode-level override if `episode` is given and
    one exists, else the title-wide TitleRoleAssignment — see
    resolve_role_assignment), instead of broadcasting to every team member
    holding that job-title role. Falls back to `fallback_broadcast_fn(message)`
    (e.g. discovery_service.notify_director) when nobody's been assigned
    yet — a team that hasn't configured assignments keeps today's behavior
    unchanged. Only ever redirects for shared titles; a personal title has
    no team to assign within, so it always uses the fallback (which itself
    already no-ops without an active team context)."""
    if title.team_id:
        assignment = resolve_role_assignment(role, db, episode=episode, title=title)
        if assignment:
            return discovery_service.notify_device(assignment.device_id, message)
    return fallback_broadcast_fn(message)


def check_and_notify_late(
    ep: Episode, role: str, character_id: "int | None", who_name: str, what_label: str, db: Session,
) -> None:
    """Episode "Адмін" tab's automatic late-submission alert (see the plan's
    §3) — called at every "this person's work just landed" trigger (actor
    Здати, translator send-to-director, director send-to-actors/-to-sound-
    engineer, sound engineer's Готово). Compares now() against that role's
    EpisodeRoleDeadline; if late, pings every team admin with who, how
    late, and for what. Silent no-op if on time or no deadline was set —
    never fires for nothing."""
    title = ep.title
    if not title.team_id:
        return
    deadline_row = db.query(EpisodeRoleDeadline).filter(
        EpisodeRoleDeadline.episode_id == ep.id, EpisodeRoleDeadline.role == role,
        EpisodeRoleDeadline.character_id == character_id,
    ).first()
    if not deadline_row or not deadline_row.deadline:
        return
    now = datetime.utcnow()
    if now <= deadline_row.deadline:
        return
    days_late = (now - deadline_row.deadline).days
    late_str = "менше дня" if days_late < 1 else f"{days_late} дн."
    message = (
        f"{who_name} здав(-ла) із запізненням: {what_label} — {title.name_ua}, "
        f"серія {ep.number}. Запізнення: {late_str}."
    )
    discovery_service.notify_all_team_admins(title.team_id, message)


# --- Push: local -> cloud ---

def share_title(title_id: int, team_id: str, db: Session) -> None:
    """Turns a personal title into a shared one — called once, right after
    local creation, when the "Спільний з командою" toggle was on."""
    base = discovery_service.get_https_base()
    if not base:
        return
    title = db.get(Title, title_id)
    profile = _active_profile(db)
    if not title or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        resp = requests.post(f"{base}/shared-titles", json={
            "team_id": team_id, "name_ua": title.name_ua, "name_original": title.name_original,
            "status": title.status, "show_key": title.show_key, "created_by_device_id": device_id,
        }, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.exception("share_title: failed to register title %s", title_id)
        return
    title.shared_id = data["id"]
    title.team_id = team_id
    db.commit()
    _notify_team(team_id, device_id)


def push_title(title_id: int, db: Session) -> None:
    """Pushes a shared title's own fields (name/status/show_key and the
    poster) — called after any local edit to those, e.g.
    routers/titles.py's update_title and routers/hikka.py's
    set_poster_from_url. Title.poster_path is almost always a remote Hikka
    CDN URL already (see set_poster_from_url's own docstring — nothing is
    downloaded/cached locally for it), so this just mirrors that string
    through the cloud row's poster_transfer_id column rather than treating
    it as an R2 object key — no upload needed for the common case. In the
    rarer case poster_path is a local file path instead, it still gets
    mirrored as a plain string here (won't resolve to an image on another
    machine, but doesn't break anything either — a real fix would need
    detecting that case and routing through R2 like the video, deferred)."""
    title = db.get(Title, title_id)
    if not title or not title.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(f"{base}/shared-titles/{title.shared_id}", json={
            "name_ua": title.name_ua, "name_original": title.name_original,
            "poster_transfer_id": title.poster_path, "status": title.status, "show_key": title.show_key,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_title: failed for title %s", title_id)
        return
    _notify_team(title.team_id, device_id)


def push_title_role_assignment(assignment: TitleRoleAssignment, db: Session) -> None:
    """Pushes a role assignment (director/translator/sound_engineer/...) —
    a plain upsert on `(shared_title_id, role)`, mirrors
    push_character_team_actor's shape. Called by routers/titles.py's
    set_title_role_assignment right after the old/new replacement
    notifications already fired (see that endpoint's own comment) — sync
    failing here doesn't undo those, same "local + notify always win,
    cloud mirror is secondary" posture as everywhere else in this module."""
    title = db.get(Title, assignment.title_id)
    if not title or not title.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(f"{base}/shared-titles/{title.shared_id}/role-assignment", json={
            "role": assignment.role, "device_id": assignment.device_id, "display_name": assignment.display_name,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_title_role_assignment: failed for title %s role %s", assignment.title_id, assignment.role)
        return
    _notify_team(title.team_id, device_id)


def push_title_role_unassignment(title_id: int, role: str, db: Session) -> None:
    """Clearing an assignment — same route, device_id: null (see the
    Worker's own delete-then-maybe-insert handling)."""
    title = db.get(Title, title_id)
    if not title or not title.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(f"{base}/shared-titles/{title.shared_id}/role-assignment", json={
            "role": role, "device_id": None,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_title_role_unassignment: failed for title %s role %s", title_id, role)
        return
    _notify_team(title.team_id, device_id)


def push_episode_role_deadline(deadline_row: EpisodeRoleDeadline, db: Session) -> None:
    """Pushes a per-episode deadline (or clears it, if `deadline_row.deadline`
    is None) — same upsert shape as push_title_role_assignment."""
    ep = db.get(Episode, deadline_row.episode_id)
    if not ep or not ep.title.shared_id:
        return
    if not ep.shared_id:
        push_episode(deadline_row.episode_id, db)
        db.refresh(ep)
        if not ep.shared_id:
            return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    char_shared_id = None
    if deadline_row.character_id:
        char = db.get(Character, deadline_row.character_id)
        char_shared_id = char.shared_id if char else None
    try:
        requests.put(f"{base}/shared-episodes/{ep.shared_id}/role-deadline", json={
            "role": deadline_row.role, "character_id": char_shared_id,
            "deadline": deadline_row.deadline.isoformat() if deadline_row.deadline else None,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_episode_role_deadline: failed for episode %s role %s", deadline_row.episode_id, deadline_row.role)
        return
    _notify_team(ep.title.team_id, device_id)


def push_episode_role_assignment(assignment: EpisodeRoleAssignment, db: Session) -> None:
    """Pushes an episode-level role-assignment override — same upsert shape
    as push_title_role_assignment, scoped to shared_episodes instead."""
    ep = db.get(Episode, assignment.episode_id)
    if not ep or not ep.title.shared_id:
        return
    if not ep.shared_id:
        push_episode(assignment.episode_id, db)
        db.refresh(ep)
        if not ep.shared_id:
            return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(f"{base}/shared-episodes/{ep.shared_id}/role-assignment", json={
            "role": assignment.role, "device_id": assignment.device_id, "display_name": assignment.display_name,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_episode_role_assignment: failed for episode %s role %s", assignment.episode_id, assignment.role)
        return
    _notify_team(ep.title.team_id, device_id)


def push_episode_role_unassignment(episode_id: int, role: str, db: Session) -> None:
    """Clearing an episode-level override — same route, device_id: null."""
    ep = db.get(Episode, episode_id)
    if not ep or not ep.title.shared_id or not ep.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(f"{base}/shared-episodes/{ep.shared_id}/role-assignment", json={
            "role": role, "device_id": None,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_episode_role_unassignment: failed for episode %s role %s", episode_id, role)
        return
    _notify_team(ep.title.team_id, device_id)


def push_actor_audio_submission_status(submission_id: int, db: Session) -> None:
    """Pushes fix_requested_at/_by_role/sent_to_sound_engineer_at after
    push_actor_audio_submission's own initial creation push — see that
    function's own comment on why this is a separate call rather than
    re-pushing the whole row (only the status fields ever change after
    creation)."""
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or not submission.shared_id:
        return
    ep = db.get(Episode, submission.episode_id)
    if not ep or not ep.title.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(f"{base}/shared-audio-submissions/{submission.shared_id}/status", json={
            "fix_requested_at": submission.fix_requested_at.isoformat() if submission.fix_requested_at else None,
            "fix_requested_by_role": submission.fix_requested_by_role,
            "sent_to_sound_engineer_at": submission.sent_to_sound_engineer_at.isoformat() if submission.sent_to_sound_engineer_at else None,
            "fix_message": submission.fix_message,
            "accepted_at": submission.accepted_at.isoformat() if submission.accepted_at else None,
            "accepted_by_name": submission.accepted_by_name,
        }, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_actor_audio_submission_status: failed for submission %s", submission_id)
        return
    _notify_team(ep.title.team_id, device_id)


def push_actor_audio_fix_markers(submission_id: int, db: Session) -> None:
    """Bulk-replace push for one submission's fix-marker set (see routers/
    actor_audio.py's import_fix_markers, the only caller) — same
    replace-the-whole-set shape as push_episode markers use, just scoped to
    one submission's shared_id instead of an episode's."""
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission or not submission.shared_id:
        return
    ep = db.get(Episode, submission.episode_id)
    if not ep or not ep.title.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    rows = [{
        "id": m.shared_id or str(uuid.uuid4()), "label": m.label,
        "position_seconds": m.position_seconds, "color": m.color,
    } for m in submission.fix_markers]
    for m, r in zip(submission.fix_markers, rows):
        if not m.shared_id:
            m.shared_id = r["id"]
    db.commit()
    try:
        requests.put(f"{base}/shared-audio-submissions/{submission.shared_id}/fix-markers", json=rows, timeout=15).raise_for_status()
    except Exception:
        logger.exception("push_actor_audio_fix_markers: failed for submission %s", submission_id)
        return
    _notify_team(ep.title.team_id, device_id)


def delete_shared_title(shared_id: str, team_id: str, device_id: str) -> None:
    """Permanent cloud-side delete (see the Worker's DELETE /shared-titles/:id) —
    unlike a plain local delete, this one does NOT come back on the next
    pull_and_merge. Only called when routers/titles.py's delete_title is
    explicitly asked for a permanent delete, not on every local title
    removal (see that function's own docstring for why the resilient
    default exists at all)."""
    base = discovery_service.get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/shared-titles/{shared_id}", timeout=15).raise_for_status()
    except Exception:
        logger.exception("delete_shared_title: failed for shared_id %s", shared_id)
        return
    _notify_team(team_id, device_id)


def delete_shared_episode(shared_id: str, team_id: str, device_id: str) -> None:
    """Permanent cloud-side delete of one episode (see the Worker's DELETE
    /shared-episodes/:id) — same posture as delete_shared_title, just one
    level down. Only called when routers/episodes.py's delete_episode is
    explicitly asked for a permanent delete."""
    base = discovery_service.get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/shared-episodes/{shared_id}", timeout=15).raise_for_status()
    except Exception:
        logger.exception("delete_shared_episode: failed for shared_id %s", shared_id)
        return
    _notify_team(team_id, device_id)


def push_episode(episode_id: int, db: Session) -> None:
    ep = db.get(Episode, episode_id)
    if not ep or not ep.title.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    payload = {
        "season": ep.season, "number": ep.number, "duration": ep.duration,
        "original_size": ep.original_size, "original_bitrate": ep.original_bitrate,
        "original_format": ep.original_format, "status": ep.status, "subtitle_stage": ep.subtitle_stage,
        "translation_started_at": ep.translation_started_at.isoformat() if ep.translation_started_at else None,
        "sound_engineer_done_at": ep.sound_engineer_done_at.isoformat() if ep.sound_engineer_done_at else None,
    }
    try:
        if ep.shared_id:
            requests.put(f"{base}/shared-episodes/{ep.shared_id}", json=payload, timeout=15).raise_for_status()
        else:
            resp = requests.post(f"{base}/shared-titles/{ep.title.shared_id}/episodes", json=payload, timeout=15)
            resp.raise_for_status()
            ep.shared_id = resp.json()["id"]
            db.commit()
    except Exception:
        logger.exception("push_episode: failed for episode %s", episode_id)
        return
    _notify_team(ep.title.team_id, device_id)


def push_actor_video_transfer_id(episode_id: int, db: Session) -> None:
    """Pushes the 480p hardsub proxy's R2 transfer id (see
    actor_video_service._run_export_actor_video) to the shared episode row
    — without this, every teammate's own local Episode row never learns
    the id, and their own GET /episodes/{id}/actor-video-url 404s forever
    (see that function's own comment on the bug this fixes)."""
    ep = db.get(Episode, episode_id)
    if not ep or not ep.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(
            f"{base}/shared-episodes/{ep.shared_id}",
            json={"actor_video_transfer_id": ep.actor_video_transfer_id}, timeout=15,
        ).raise_for_status()
    except Exception:
        logger.exception("push_actor_video_transfer_id: failed for episode %s", episode_id)
        return
    _notify_team(ep.title.team_id, device_id)


def push_cleaned_video_transfer_id(episode_id: int, db: Session) -> None:
    """Pushes the клінапер's uploaded result's R2 transfer id — same shape
    as push_actor_video_transfer_id, its own dedicated push since it changes
    independently of the rest of an episode's metadata."""
    ep = db.get(Episode, episode_id)
    if not ep or not ep.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(
            f"{base}/shared-episodes/{ep.shared_id}",
            json={
                "cleaned_video_transfer_id": ep.cleaned_video_transfer_id,
                "cleaned_video_filename": ep.cleaned_video_filename,
                "cleaned_video_uploaded_at": ep.cleaned_video_uploaded_at.isoformat() if ep.cleaned_video_uploaded_at else None,
            }, timeout=15,
        ).raise_for_status()
    except Exception:
        logger.exception("push_cleaned_video_transfer_id: failed for episode %s", episode_id)
        return
    _notify_team(ep.title.team_id, device_id)


def push_episode_video_async(episode_id: int) -> None:
    """Fire-and-forget entry point — see the call site in
    ffmpeg_service.run_import_pipeline, right after a local video import
    finishes. Always uploads to R2 regardless of whether any teammate is
    online right now (server-mediated only, no P2P shortcut) — runs in its
    own thread since a multi-GB upload must never block the local import
    the user is actively waiting on. Opens its own DB session (this runs
    well after any request-scoped session would have closed)."""
    threading.Thread(target=_push_episode_video, args=(episode_id,), daemon=True).start()


def _push_episode_video(episode_id: int) -> None:
    from ..database import SessionLocal
    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep or not ep.title.shared_id or not ep.original_file_path:
            return
        if not ep.shared_id:
            push_episode(episode_id, db)
            db.refresh(ep)
            if not ep.shared_id:
                return
        base = discovery_service.get_https_base()
        profile = _active_profile(db)
        if not base or not profile:
            return
        device_id = _team_device_id(profile.name)
        if not os.path.isfile(ep.original_file_path):
            return
        transfer_id = f"rh-team-video-{ep.id}-{uuid.uuid4().hex}"
        size = os.path.getsize(ep.original_file_path)
        progress_file = _ProgressFile(ep.original_file_path, size)
        try:
            discovery_service.upload_transfer(transfer_id, progress_file, size)
        finally:
            progress_file.close()
        requests.put(f"{base}/shared-episodes/{ep.shared_id}", json={
            "video_transfer_id": transfer_id,
            "original_filename": ep.original_filename or os.path.basename(ep.original_file_path),
        }, timeout=15).raise_for_status()
        ep.last_synced_video_transfer_id = transfer_id
        db.commit()
        _notify_team(ep.title.team_id, device_id)
    except Exception:
        logger.exception("push_episode_video: failed for episode %s", episode_id)
    finally:
        db.close()


def push_character(character_id: int, db: Session) -> None:
    char = db.get(Character, character_id)
    if not char or not char.title.shared_id or char.shared_id:
        return  # no rename route yet (rare) — only push a character the first time
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        resp = requests.post(
            f"{base}/shared-titles/{char.title.shared_id}/characters",
            json={"name": char.name, "code": char.code, "team_device_id": char.team_device_id}, timeout=15,
        )
        resp.raise_for_status()
        char.shared_id = resp.json()["id"]
        db.commit()
    except Exception:
        logger.exception("push_character: failed for character %s", character_id)
        return
    _notify_team(char.title.team_id, device_id)


def push_character_team_actor(character_id: int, db: Session) -> None:
    """A character's `team_device_id` set/changed AFTER it was already
    pushed once (see routers/characters.py's PUT /characters/{id}/team-actor)
    — push_character above only ever fires on the character's first push, so
    without this, assigning a real team actor to an existing shared
    character would stay a purely local change on the assigning device and
    never reach that actor's own install via pull_and_merge (confirmed live
    2026-08-19: a director-assigned actor saw nothing in their own ActorWorkspace
    despite the assignment looking correct on the director's side)."""
    char = db.get(Character, character_id)
    if not char or not char.shared_id:
        return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    try:
        requests.put(
            f"{base}/shared-characters/{char.shared_id}",
            json={"team_device_id": char.team_device_id}, timeout=15,
        ).raise_for_status()
    except Exception:
        logger.exception("push_character_team_actor: failed for character %s", character_id)
        return
    _notify_team(char.title.team_id, device_id)


def push_subtitle_lines(episode_id: int, db: Session) -> None:
    """Bulk-replace push — simpler and more robust than per-line diffing,
    mirrors the Worker's own bulk-replace route (and this app's pre-existing
    local PUT /episodes/{id}/subtitle-lines undo-restore endpoint)."""
    ep = db.get(Episode, episode_id)
    if not ep or not ep.title.shared_id:
        return
    if not ep.shared_id:
        push_episode(episode_id, db)
        db.refresh(ep)
        if not ep.shared_id:
            return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    lines = db.query(SubtitleLine).filter(SubtitleLine.episode_id == episode_id).order_by(SubtitleLine.start_ms).all()
    char_shared_ids = {c.id: c.shared_id for c in db.query(Character).filter(Character.title_id == ep.title_id).all()}
    payload = [{
        "start_ms": l.start_ms, "end_ms": l.end_ms, "text": l.text,
        "character_id": char_shared_ids.get(l.character_id) if l.character_id else None,
        "ass_style": l.ass_style, "is_overlap": l.is_overlap, "layer": l.layer,
        "margin_l": l.margin_l, "margin_r": l.margin_r, "margin_v": l.margin_v,
    } for l in lines]
    try:
        resp = requests.post(f"{base}/shared-episodes/{ep.shared_id}/subtitle-lines", json=payload, timeout=30)
        resp.raise_for_status()
        pushed = resp.json()
        for local_line, remote in zip(lines, pushed):
            local_line.shared_id = remote["id"]
        db.commit()
    except Exception:
        logger.exception("push_subtitle_lines: failed for episode %s", episode_id)
        return
    _notify_team(ep.title.team_id, device_id)


def push_markers(episode_id: int, db: Session) -> None:
    """Bulk-replace push, identical shape to push_subtitle_lines above —
    markers used to be 100% local-only (no shared_markers table existed at
    all), so a remote actor's own per-actor CSV/ReaScript download (see
    reaper_exporter.py's _filter_markers_for_actor) always came back
    completely empty on any install other than the one that placed the
    markers (confirmed live 2026-08-19). Called after every marker
    create/update/delete/import/color-assign (see routers/markers.py)."""
    ep = db.get(Episode, episode_id)
    if not ep or not ep.title.shared_id:
        return
    if not ep.shared_id:
        push_episode(episode_id, db)
        db.refresh(ep)
        if not ep.shared_id:
            return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    markers = db.query(Marker).filter(Marker.episode_id == episode_id).order_by(Marker.position_seconds).all()
    char_shared_ids = {c.id: c.shared_id for c in db.query(Character).filter(Character.title_id == ep.title_id).all()}
    payload = [{
        "reaper_name": m.reaper_name, "position_seconds": m.position_seconds, "confirmed": m.confirmed,
        "color": m.color, "character_id": char_shared_ids.get(m.character_id) if m.character_id else None,
    } for m in markers]
    try:
        resp = requests.post(f"{base}/shared-episodes/{ep.shared_id}/markers", json=payload, timeout=30)
        resp.raise_for_status()
        pushed = resp.json()
        for local_marker, remote in zip(markers, pushed):
            local_marker.shared_id = remote["id"]
        db.commit()
    except Exception:
        logger.exception("push_markers: failed for episode %s", episode_id)
        return
    _notify_team(ep.title.team_id, device_id)


def push_actor_audio_submission(submission_id: int, db: Session) -> None:
    """One-shot push, called once right after a "Здати" upload finishes
    (see actor_audio_service._run_submit_actor_audio) — additive, NOT a
    bulk-replace like push_markers/push_subtitle_lines, since each
    submission is an independent file already sitting in R2 under its own
    transfer_id; only the METADATA row needs to sync, not the file itself.
    Without this, the director/sound-engineer's own "Звукові доріжки" tab
    stayed permanently empty on any install other than the actor's own
    (confirmed live 2026-08-19)."""
    submission = db.get(ActorAudioSubmission, submission_id)
    if not submission:
        return
    ep = db.get(Episode, submission.episode_id)
    if not ep or not ep.title.shared_id:
        return
    if not ep.shared_id:
        push_episode(submission.episode_id, db)
        db.refresh(ep)
        if not ep.shared_id:
            return
    base = discovery_service.get_https_base()
    profile = _active_profile(db)
    if not base or not profile:
        return
    device_id = _team_device_id(profile.name)
    char_shared_id = None
    if submission.character_id:
        char = db.get(Character, submission.character_id)
        char_shared_id = char.shared_id if char else None
    # The ORIGINAL submission's shared_id, not its local numeric id — a
    # local id means nothing on a teammate's device. Resolved back to a
    # local id on pull via the remote_sub_shared_ids map built in
    # pull_and_merge (same "cross-device id via shared_id" pattern as
    # character_id above).
    fix_of_shared_id = None
    if submission.fix_of_submission_id:
        original = db.get(ActorAudioSubmission, submission.fix_of_submission_id)
        fix_of_shared_id = original.shared_id if original else None
    try:
        resp = requests.post(f"{base}/shared-episodes/{ep.shared_id}/audio-submissions", json={
            "character_id": char_shared_id, "filename": submission.filename, "transfer_id": submission.transfer_id,
            "uploaded_by_device_id": submission.uploaded_by_device_id, "uploaded_by_name": submission.uploaded_by_name,
            "fix_of_submission_id": fix_of_shared_id,
        }, timeout=15)
        resp.raise_for_status()
        submission.shared_id = resp.json()["id"]
        db.commit()
    except Exception:
        logger.exception("push_actor_audio_submission: failed for submission %s", submission_id)
        return
    _notify_team(ep.title.team_id, device_id)


def delete_shared_audio_submission(shared_id: str) -> None:
    """Propagates a local delete (see routers/actor_audio.py's
    delete_actor_audio) so the submission actually disappears from
    teammates' installs too on their next pull, instead of only vanishing
    on the device that deleted it."""
    base = discovery_service.get_https_base()
    if not base:
        return
    try:
        requests.delete(f"{base}/shared-audio-submissions/{shared_id}", timeout=15)
    except Exception:
        logger.exception("delete_shared_audio_submission: failed for shared_id %s", shared_id)


# --- Pull: cloud -> local ---

def pull_and_merge_all_teams(db: Session) -> None:
    """Convenience wrapper — pulls every team the active profile belongs to.
    Used by the periodic heartbeat fallback and the post-join/startup hook,
    neither of which know a specific team_id up front."""
    profile = _active_profile(db)
    if not profile:
        return
    try:
        teams = team_service.my_teams(profile.name)
    except Exception:
        return
    for team in teams:
        pull_and_merge(team["id"], db)


def pull_and_merge(team_id: str, db: Session) -> None:
    base = discovery_service.get_https_base()
    if not base:
        return
    try:
        resp = requests.get(f"{base}/shared-titles", params={"team_id": team_id}, timeout=30)
        resp.raise_for_status()
        remote_titles = resp.json()
    except Exception:
        logger.exception("pull_and_merge: failed to fetch snapshot for team %s", team_id)
        return

    # Reconcile deletions: the add/update loop below only ever creates or
    # refreshes rows present in the snapshot — it never notices a title
    # that USED to be shared and now isn't (e.g. someone permanently
    # deleted it, see routers/titles.py's delete_title). Without this, a
    # permanent delete only ever took effect on the deleting device itself
    # (and even there only until the next sync, since a stale local mirror
    # with a live shared_id would otherwise just get re-fetched — this is
    # the same "titles I deleted came back" bug the missing reconciliation
    # here caused). Trusts the full snapshot as authoritative, same as the
    # rest of this function; an empty `remote_titles` legitimately means
    # "this team currently shares nothing."
    remote_ids = {rt["id"] for rt in remote_titles}
    stale_query = db.query(Title).filter(Title.team_id == team_id, Title.shared_id.isnot(None))
    if remote_ids:
        stale_query = stale_query.filter(~Title.shared_id.in_(remote_ids))
    stale_titles = stale_query.all()
    if stale_titles:
        from ..routers.episodes import delete_episode_files
        for stale in stale_titles:
            episode_ids = [row[0] for row in db.query(Episode.id).filter(Episode.title_id == stale.id).all()]
            db.delete(stale)
            db.commit()
            for ep_id in episode_ids:
                delete_episode_files(ep_id)

    for rt in remote_titles:
        # poster_transfer_id is really just a plain mirror of Title.poster_path
        # (almost always a remote Hikka CDN URL already — see push_title's
        # own docstring), not an actual R2 object key — no download needed.
        poster = rt.get("poster_transfer_id")
        title = db.query(Title).filter(Title.shared_id == rt["id"]).first()
        if not title:
            title = Title(
                shared_id=rt["id"], team_id=team_id, name_ua=rt["name_ua"], name_original=rt["name_original"],
                status=rt["status"], show_key=rt["show_key"], poster_path=poster,
            )
            db.add(title)
            db.flush()
        else:
            title.name_ua = rt["name_ua"]
            title.name_original = rt["name_original"]
            title.status = rt["status"]
            title.show_key = rt["show_key"]
            if poster:
                title.poster_path = poster
        db.commit()

        remote_char_ids: dict[str, int] = {}
        for rc in rt.get("characters", []):
            char = db.query(Character).filter(Character.shared_id == rc["id"]).first()
            if not char:
                char = Character(
                    shared_id=rc["id"], title_id=title.id, name=rc["name"], code=rc.get("code"),
                    team_device_id=rc.get("team_device_id"),
                )
                db.add(char)
                db.flush()
            else:
                char.name = rc["name"]
                char.code = rc.get("code")
                char.team_device_id = rc.get("team_device_id")
            remote_char_ids[rc["id"]] = char.id
        db.commit()

        # Role assignments: find-or-create by the natural (title_id, role)
        # key (no per-row shared_id needed, same as team_members' own
        # composite-key identity) plus reconciliation — a role cleared on
        # another device (missing from the snapshot) gets cleared here too.
        remote_role_keys = {ra["role"] for ra in rt.get("role_assignments", [])}
        stale_assignments_query = db.query(TitleRoleAssignment).filter(TitleRoleAssignment.title_id == title.id)
        if remote_role_keys:
            stale_assignments_query = stale_assignments_query.filter(~TitleRoleAssignment.role.in_(remote_role_keys))
        stale_assignments_query.delete(synchronize_session=False)
        for ra in rt.get("role_assignments", []):
            assignment = db.query(TitleRoleAssignment).filter(
                TitleRoleAssignment.title_id == title.id, TitleRoleAssignment.role == ra["role"],
            ).first()
            if not assignment:
                assignment = TitleRoleAssignment(title_id=title.id, role=ra["role"])
                db.add(assignment)
            assignment.device_id = ra["device_id"]
            assignment.display_name = ra["display_name"]
        db.commit()

        for re_ in rt.get("episodes", []):
            ep = db.query(Episode).filter(Episode.shared_id == re_["id"]).first()
            if not ep:
                ep = Episode(shared_id=re_["id"], title_id=title.id, number=re_["number"], season=re_["season"])
                db.add(ep)
                db.flush()
            ep.season = re_["season"]
            ep.number = re_["number"]
            ep.duration = re_["duration"]
            ep.original_size = re_["original_size"]
            ep.original_bitrate = re_["original_bitrate"]
            ep.original_format = re_["original_format"]
            ep.status = re_["status"]
            ep.subtitle_stage = re_["subtitle_stage"]
            ep.translation_started_at = _parse_iso(re_.get("translation_started_at"))
            ep.sound_engineer_done_at = _parse_iso(re_.get("sound_engineer_done_at"))
            # Just the reference id, not a download — GET /episodes/{id}/
            # actor-video-url builds the URL from this on demand, same as
            # the device that generated it originally (see
            # push_actor_video_transfer_id's own comment).
            remote_actor_video_id = re_.get("actor_video_transfer_id")
            if remote_actor_video_id:
                ep.actor_video_transfer_id = remote_actor_video_id
            remote_cleaned_video_id = re_.get("cleaned_video_transfer_id")
            if remote_cleaned_video_id:
                ep.cleaned_video_transfer_id = remote_cleaned_video_id
                ep.cleaned_video_filename = re_.get("cleaned_video_filename")
                ep.cleaned_video_uploaded_at = _parse_iso(re_.get("cleaned_video_uploaded_at"))
            db.commit()

            # Bulk-replace, mirroring the push side's own semantics — the
            # incoming set is authoritative for this episode's lines.
            # EXCEPT: if the remote side is empty but we already have local
            # lines, do NOT wipe them — an empty remote snapshot almost
            # always means "this episode's lines haven't been pushed yet by
            # whoever has them locally" (e.g. a push that's still in flight,
            # or — confirmed live 2026-08-17 — a code path that created
            # lines without pushing at all, see subtitle_parser.py's ASS
            # import fix) rather than "someone genuinely deleted everything
            # remotely." Losing a real import to a race like that is far
            # worse than occasionally missing a legitimate remote-side
            # clear-all, so this errs toward not deleting.
            remote_lines = re_.get("subtitle_lines", [])
            existing_local_count = db.query(SubtitleLine).filter(SubtitleLine.episode_id == ep.id).count()
            if remote_lines or existing_local_count == 0:
                db.query(SubtitleLine).filter(SubtitleLine.episode_id == ep.id).delete()
                db.flush()
                for rl in remote_lines:
                    local_char_id = remote_char_ids.get(rl["character_id"]) if rl.get("character_id") else None
                    db.add(SubtitleLine(
                        shared_id=rl["id"], episode_id=ep.id, start_ms=rl["start_ms"], end_ms=rl["end_ms"],
                        text=rl["text"], character_id=local_char_id, ass_style=rl["ass_style"],
                        is_overlap=bool(rl["is_overlap"]), layer=rl["layer"],
                        margin_l=rl["margin_l"], margin_r=rl["margin_r"], margin_v=rl["margin_v"],
                    ))
                db.commit()

            # Markers: same bulk-replace-unless-remote-is-empty posture as
            # subtitle lines just above (see that block's own comment for
            # why an empty remote snapshot doesn't wipe real local data).
            remote_markers = re_.get("markers", [])
            existing_marker_count = db.query(Marker).filter(Marker.episode_id == ep.id).count()
            if remote_markers or existing_marker_count == 0:
                db.query(Marker).filter(Marker.episode_id == ep.id).delete()
                db.flush()
                for rm in remote_markers:
                    local_char_id = remote_char_ids.get(rm["character_id"]) if rm.get("character_id") else None
                    db.add(Marker(
                        shared_id=rm["id"], episode_id=ep.id, reaper_name=rm["reaper_name"],
                        position_seconds=rm["position_seconds"], confirmed=bool(rm["confirmed"]),
                        color=rm.get("color"), character_id=local_char_id,
                    ))
                db.commit()

            # Audio submissions: additive find-or-create by shared_id (NOT
            # a bulk-replace like lines/markers above — each row is an
            # independent uploaded file, see push_actor_audio_submission's
            # own comment), plus explicit deletion reconciliation (same
            # "stale rows whose shared_id vanished from the snapshot get
            # removed" pattern as the stale-titles reconciliation earlier
            # in this function) so a deleted submission actually disappears
            # for everyone, not just the device that deleted it.
            remote_subs = re_.get("audio_submissions", [])
            remote_sub_ids = {rs["id"] for rs in remote_subs}
            stale_subs_query = db.query(ActorAudioSubmission).filter(
                ActorAudioSubmission.episode_id == ep.id, ActorAudioSubmission.shared_id.isnot(None),
            )
            if remote_sub_ids:
                stale_subs_query = stale_subs_query.filter(~ActorAudioSubmission.shared_id.in_(remote_sub_ids))
            stale_subs_query.delete(synchronize_session=False)
            for rs in remote_subs:
                sub = db.query(ActorAudioSubmission).filter(ActorAudioSubmission.shared_id == rs["id"]).first()
                if not sub:
                    local_char_id = remote_char_ids.get(rs["character_id"]) if rs.get("character_id") else None
                    sub = ActorAudioSubmission(
                        shared_id=rs["id"], episode_id=ep.id, character_id=local_char_id,
                        filename=rs["filename"], transfer_id=rs["transfer_id"],
                        uploaded_by_device_id=rs.get("uploaded_by_device_id"),
                        uploaded_by_name=rs.get("uploaded_by_name", "?"),
                    )
                    db.add(sub)
                # Status fields DO change after creation (fix requested /
                # forwarded to sound engineer — see
                # push_actor_audio_submission_status), so these need
                # updating on every pull, not just set once at creation.
                sub.fix_requested_at = _parse_iso(rs.get("fix_requested_at"))
                sub.fix_requested_by_role = rs.get("fix_requested_by_role")
                sub.sent_to_sound_engineer_at = _parse_iso(rs.get("sent_to_sound_engineer_at"))
                sub.fix_message = rs.get("fix_message")
                sub.accepted_at = _parse_iso(rs.get("accepted_at"))
                sub.accepted_by_name = rs.get("accepted_by_name")
                db.flush()
                # Fix markers: bulk-replace per submission, same posture as
                # the episode-level markers block above (see
                # push_actor_audio_fix_markers, the only pusher) — a fresh
                # review pass fully supersedes the last synced set.
                remote_fix_markers = rs.get("fix_markers") or []
                if remote_fix_markers or db.query(ActorAudioFixMarker).filter(ActorAudioFixMarker.submission_id == sub.id).count() == 0:
                    db.query(ActorAudioFixMarker).filter(ActorAudioFixMarker.submission_id == sub.id).delete()
                    for rfm in remote_fix_markers:
                        db.add(ActorAudioFixMarker(
                            shared_id=rfm["id"], submission_id=sub.id, label=rfm.get("label", ""),
                            position_seconds=rfm["position_seconds"], color=rfm.get("color"),
                        ))
            # fix_of_submission_id needs every row's local id resolved
            # first — a second pass over the same remote list, since the
            # ORIGINAL a fix points at can appear later in the snapshot
            # than the fix itself.
            for rs in remote_subs:
                fix_of_shared = rs.get("fix_of_submission_id")
                if not fix_of_shared:
                    continue
                sub = db.query(ActorAudioSubmission).filter(ActorAudioSubmission.shared_id == rs["id"]).first()
                original = db.query(ActorAudioSubmission).filter(ActorAudioSubmission.shared_id == fix_of_shared).first()
                if sub and original:
                    sub.fix_of_submission_id = original.id
            db.commit()

            # Role deadlines: same find-or-create-by-natural-key +
            # reconciliation shape as role assignments above, keyed
            # (episode_id, role, character_id).
            remote_deadlines = re_.get("role_deadlines", [])
            remote_deadline_keys = {
                (rd["role"], remote_char_ids.get(rd["character_id"]) if rd.get("character_id") else None)
                for rd in remote_deadlines
            }
            for existing in db.query(EpisodeRoleDeadline).filter(EpisodeRoleDeadline.episode_id == ep.id).all():
                if (existing.role, existing.character_id) not in remote_deadline_keys:
                    db.delete(existing)
            for rd in remote_deadlines:
                local_char_id = remote_char_ids.get(rd["character_id"]) if rd.get("character_id") else None
                row = db.query(EpisodeRoleDeadline).filter(
                    EpisodeRoleDeadline.episode_id == ep.id, EpisodeRoleDeadline.role == rd["role"],
                    EpisodeRoleDeadline.character_id == local_char_id,
                ).first()
                if not row:
                    row = EpisodeRoleDeadline(episode_id=ep.id, role=rd["role"], character_id=local_char_id)
                    db.add(row)
                row.deadline = _parse_iso(rd.get("deadline"))
            db.commit()

            # Episode-level role-assignment overrides: same
            # find-or-create-by-natural-key + reconciliation shape as the
            # title-level role assignments above, keyed (episode_id, role).
            remote_ep_assignments = re_.get("role_assignments", [])
            remote_ep_role_keys = {ra["role"] for ra in remote_ep_assignments}
            stale_ep_assignments_query = db.query(EpisodeRoleAssignment).filter(EpisodeRoleAssignment.episode_id == ep.id)
            if remote_ep_role_keys:
                stale_ep_assignments_query = stale_ep_assignments_query.filter(~EpisodeRoleAssignment.role.in_(remote_ep_role_keys))
            stale_ep_assignments_query.delete(synchronize_session=False)
            for ra in remote_ep_assignments:
                assignment = db.query(EpisodeRoleAssignment).filter(
                    EpisodeRoleAssignment.episode_id == ep.id, EpisodeRoleAssignment.role == ra["role"],
                ).first()
                if not assignment:
                    assignment = EpisodeRoleAssignment(episode_id=ep.id, role=ra["role"])
                    db.add(assignment)
                assignment.device_id = ra["device_id"]
                assignment.display_name = ra["display_name"]
            db.commit()

            # Video: NOT auto-downloaded (confirmed live 2026-08-19 as
            # wasteful for a multi-GB file nobody may need locally yet) —
            # just remember the id and real filename so
            # routers/episodes.py's download-original-video can fetch it
            # on demand later. last_synced_video_transfer_id stays untouched
            # here; it's only ever set once an actual download completes
            # (see download_episode_video), so it still means "the id
            # that's really on disk right now" for that job's own dedup
            # check, distinct from remote_video_transfer_id ("the latest id
            # the cloud knows about").
            remote_video_id = re_.get("video_transfer_id")
            if remote_video_id:
                ep.remote_video_transfer_id = remote_video_id
            remote_filename = re_.get("original_filename")
            if remote_filename:
                ep.original_filename = remote_filename
            db.commit()


def download_episode_video(episode_id: int, reporter=None) -> dict:
    """On-demand pull of the raw original video (see routers/episodes.py's
    POST /episodes/{id}/download-original-video) — deliberately NOT
    triggered automatically by pull_and_merge (see that function's own
    comment on why: wasteful for a multi-GB file nobody may need locally
    yet). Only pulls the video itself — enough for the video/waveform
    panels in the Translator/Director workspaces (they stream
    original_file_path directly, no pre-extraction needed). Does NOT also
    run the local audio-extraction step import_video normally does
    (audio_stem_path stays empty) — vocal separation on a pulled-in shared
    episode needs that run locally first, same as any freshly-imported
    episode; a known, deliberate scope limit for this pass.
    Keeps the ORIGINAL filename (Episode.original_filename, synced from
    whoever imported it) rather than a synthetic name, so the file matches
    exactly what a teammate would expect (and what the future Telegram
    original-video channel post will reference).

    UPDATE 2026-09-08: the "does NOT extract audio" limitation above was a
    real bug, not just a scope note — confirmed live: a sound engineer who
    pulled a shared episode's video this way got "Audio stem not found —
    import video first" from POST /episodes/{id}/separate-vocals on every
    attempt, with no way to fix it short of re-importing the whole episode
    from scratch (which would also re-create it, wrong episode number
    handling aside). Now runs the same ffmpeg audio-extraction step
    run_import_pipeline uses, right after the video itself lands, so
    audio_stem_path is populated exactly like a fresh local import."""
    from ..database import SessionLocal
    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep or not ep.remote_video_transfer_id:
            raise ValueError("Оригінальне відео ще не завантажено в хмару")
        transfer_id = ep.remote_video_transfer_id
        ep_dir = Path(DATA_DIR) / "episodes" / str(ep.id)
        ep_dir.mkdir(parents=True, exist_ok=True)
        filename = ep.original_filename or f"shared_original.{ep.original_format or 'mp4'}"
        dest_path = str(ep_dir / filename)
        if reporter:
            reporter.update(1, "Завантажую оригінал з хмари…")
        try:
            discovery_service.download_transfer(
                transfer_id, dest_path,
                # 0-85% for the download itself, leaving room for the
                # ffmpeg extraction pass below — otherwise progress would
                # jump straight from 100% to "still working" with no
                # visible movement during extraction.
                on_progress=(lambda pct: reporter.update(int(pct * 0.85), "Завантажую оригінал з хмари…")) if reporter else None,
            )
        except Exception:
            logger.exception("download_episode_video: failed for episode %s transfer=%s", episode_id, transfer_id)
            raise
        ep.original_file_path = dest_path
        ep.last_synced_video_transfer_id = transfer_id
        db.commit()

        from .ffmpeg_service import run_import_ffmpeg_only
        try:
            result = run_import_ffmpeg_only(
                dest_path, str(ep_dir),
                on_progress=(lambda pct, msg: reporter.update(85 + int(pct * 0.15), msg)) if reporter else None,
            )
            ep.audio_stem_path = result["audio_path"]
            ep.original_size = result["file_size"]
            ep.original_bitrate = result["bit_rate"]
            ep.original_format = result["format_name"]
            ep.duration = result["duration"]
            db.commit()
        except Exception:
            # The video itself is already down and playable even if this
            # fails (e.g. a corrupt/unsupported container) — don't fail the
            # whole download over it, just leave audio_stem_path empty like
            # before this fix (separation still 400s with a clear message,
            # no worse than the old behavior).
            logger.exception("download_episode_video: audio extraction failed for episode %s", episode_id)

        if reporter:
            reporter.update(100, "Готово")
        return {"original_file_path": dest_path}
    finally:
        db.close()
