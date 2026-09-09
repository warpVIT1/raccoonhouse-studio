from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import AppSettings, Profile
from ..schemas import TeamCreateIn, TeamInviteIn, TeamInviteRespondIn, TeamJoinIn
from ..services import device_identity_service, team_service

router = APIRouter(prefix="/teams", tags=["teams"])


def _active_profile_name(db: Session) -> str:
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    if not profile:
        raise HTTPException(400, "Немає активного профілю")
    return profile.name


def _active_profile_name_or_none(db: Session) -> Optional[str]:
    """Same lookup as _active_profile_name, but for endpoints where "no
    active profile yet" is a normal transient state (e.g. right after a
    fresh install, before the first profile is created/picked) rather than
    a real error — an empty result is the correct answer, not a 400.
    Confirmed live 2026-08-10: TeamsPage's own load() fetches this,
    is-app-admin, and pending invites together via Promise.all, so a hard
    400 from just this one endpoint silently blanked out the other two as
    well (is_app_admin included) with no visible error — see also the
    frontend fix switching that to Promise.allSettled."""
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    return profile.name if profile else None


@router.get("")
def list_teams(db: Session = Depends(get_db)):
    try:
        return team_service.list_teams(_active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/mine")
def my_teams(db: Session = Depends(get_db)):
    name = _active_profile_name_or_none(db)
    return team_service.my_teams(name) if name else []


@router.get("/{team_id}/preview")
def preview_team_content(team_id: str, db: Session = Depends(get_db)):
    """Admin "box" — read-only preview of a team's full production
    content (titles/episodes/subtitles/markers/audio/video refs), never
    written to local SQLite. See team_service.admin_preview_team_content."""
    try:
        return team_service.admin_preview_team_content(team_id, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/preview/transfer-url")
def preview_transfer_url(transfer_id: str, filename: str | None = None, db: Session = Depends(get_db)):
    """Resolves a raw transfer_id from another team's preview snapshot
    (see preview_team_content above) into a playable/downloadable URL —
    the admin never sees the frontend hardcode the Worker's base URL,
    same "resolve server-side" posture as get_actor_video_url/
    get_actor_audio_url, just generic since the caller here has no local
    Episode/ActorAudioSubmission row for content that isn't theirs.
    Gated the same as the preview itself, even though the URL alone isn't
    sensitive — keeps this from becoming a general-purpose id-to-url
    endpoint for anything other than what this feature was built for."""
    profile_name = _active_profile_name(db)
    if not profile_name or not team_service.is_app_admin(profile_name):
        raise HTTPException(403, "Лише адмін програми")
    from ..services import discovery_service
    base = discovery_service.get_https_base()
    if not base:
        raise HTTPException(400, "Онлайн-сигналізація не налаштована")
    from urllib.parse import quote
    url = f"{base}/transfer/{transfer_id}"
    if filename:
        url += f"?filename={quote(filename)}"
    return {"url": url}


@router.get("/is-app-admin")
def is_app_admin(db: Session = Depends(get_db)):
    try:
        name = _active_profile_name(db)
    except HTTPException:
        return {"is_app_admin": False, "device_id": None}
    return {"is_app_admin": team_service.is_app_admin(name), "device_id": device_identity_service.get_profile_id(name)}


@router.post("", status_code=201)
def create_team(body: TeamCreateIn, db: Session = Depends(get_db)):
    try:
        return team_service.create_team(body.name, body.password, body.credits_enabled, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except Exception as e:
        raise HTTPException(502, str(e))


@router.post("/join")
def join_team(body: TeamJoinIn, db: Session = Depends(get_db)):
    try:
        team_service.join_team(body.name, body.password, body.display_name, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(404, str(e))
    # Immediate catch-up so shared titles already on the team don't wait for
    # the next periodic pull (~5min) or someone else's next push — see
    # sync_service.pull_and_merge_all_teams.
    from ..services import sync_service
    sync_service.pull_and_merge_all_teams(db)
    return {"ok": True}


@router.get("/{team_id}/members")
def get_team_members(team_id: str):
    return team_service.team_members(team_id)


@router.get("/{team_id}/actors")
def get_team_actors(team_id: str, role: str = "actor"):
    # `role` — since 2026-08-19 also reused by the title "Команда тайтлу"
    # panel's per-role assignment dropdowns (director/translator/
    # sound_engineer/...), not just the subtitle grid's own АКТОР picker.
    members = team_service.list_team_actors(team_id, role)
    if role != "actor":
        return members
    # A synthetic pseudo-actor pinned to the top — pick it for a subtitle
    # line or marker to mean "this goes out to every actor's own export",
    # not one specific person (see srt_exporter.export_srt_for_character
    # and reaper_exporter._filter_markers_for_actor's own comments on the
    # "everyone" sentinel team_device_id). Not a real team member, so it's
    # added here rather than coming from the Worker's own /team-actors.
    # Only meaningful for the actor role.
    everyone = {"device_id": "everyone", "display_name": "Усі"}
    return [everyone, *members]


@router.delete("/{team_id}")
def delete_team(team_id: str, db: Session = Depends(get_db)):
    try:
        team_service.delete_team(team_id, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.put("/{team_id}/credits")
def set_team_credits(team_id: str, body: dict, db: Session = Depends(get_db)):
    try:
        team_service.set_team_credits(team_id, bool(body.get("enabled")), _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.delete("/{team_id}/members/{device_id}")
def remove_member(team_id: str, device_id: str, db: Session = Depends(get_db)):
    try:
        team_service.remove_member(team_id, device_id, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.put("/{team_id}/members/{device_id}/admin")
def set_team_admin(team_id: str, device_id: str, body: dict, db: Session = Depends(get_db)):
    try:
        team_service.set_team_admin(team_id, device_id, bool(body.get("is_admin")), _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.put("/{team_id}/name")
def rename_team(team_id: str, body: dict, db: Session = Depends(get_db)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "name is required")
    try:
        team_service.rename_team(team_id, name, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    except ValueError as e:
        raise HTTPException(409, str(e))
    return {"ok": True, "name": name}


@router.put("/{team_id}/members/{device_id}/roles")
def set_member_roles(team_id: str, device_id: str, body: dict, db: Session = Depends(get_db)):
    roles = body.get("roles")
    if not isinstance(roles, list):
        raise HTTPException(400, "roles must be a list")
    try:
        team_service.set_member_roles(team_id, device_id, roles, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.post("/invite")
def invite_member(body: TeamInviteIn, db: Session = Depends(get_db)):
    try:
        return team_service.invite_member(body.team_id, body.invited_device_id, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/invites/pending")
def pending_invites(db: Session = Depends(get_db)):
    name = _active_profile_name_or_none(db)
    return team_service.pending_invites(name) if name else []


@router.post("/invites/respond")
def respond_to_invite(body: TeamInviteRespondIn, db: Session = Depends(get_db)):
    team_service.respond_to_invite(body.invite_id, body.accept, body.display_name)
    if body.accept:
        # Same immediate catch-up as /join above — this is the other entry
        # point into a team (invite-accept vs type-name-and-password).
        from ..services import sync_service
        sync_service.pull_and_merge_all_teams(db)
    return {"ok": True}


@router.get("/admin/server-stats")
def server_stats(db: Session = Depends(get_db)):
    try:
        return team_service.get_server_stats(_active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/users/all")
def all_known_users(db: Session = Depends(get_db)):
    try:
        return team_service.all_known_users(_active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))


@router.get("/users/{device_id}/log")
def get_user_log(device_id: str, filename: str, db: Session = Depends(get_db)):
    """Live console-log viewer for the admin "База даних" tab — reuses the
    exact same peer-to-peer relay call the Power Share admin log viewer
    already had (see discovery_service.fetch_peer_log), just resolved by
    team device_id instead of the power-share peer_id (see
    fetch_log_by_device_id). Only works while that person is online."""
    if not team_service.is_app_admin(_active_profile_name(db)):
        raise HTTPException(403, "Лише адмін програми може переглядати журнали інших")
    from ..services import discovery_service
    try:
        return {"content": discovery_service.fetch_log_by_device_id(device_id, filename)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except TimeoutError:
        raise HTTPException(504, "Користувач не відповів вчасно")


@router.delete("/users/{device_id}")
def delete_known_user(device_id: str, db: Session = Depends(get_db)):
    try:
        team_service.delete_known_user(device_id, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.put("/users/{device_id}/credits")
def set_credit_grant(device_id: str, body: dict, db: Session = Depends(get_db)):
    try:
        team_service.set_credit_grant(device_id, bool(body.get("enabled")), _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.post("/users/{device_id}/message")
def send_message_to_user(device_id: str, body: dict, db: Session = Depends(get_db)):
    message = str(body.get("message", "")).strip()
    if not message:
        raise HTTPException(400, "message is required")
    try:
        sent = team_service.send_message_to_user(device_id, message, _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"sent": sent}


@router.get("/mvsep-config")
def get_mvsep_config():
    # Never api_token — see team_service.get_mvsep_public_config.
    return team_service.get_mvsep_public_config()


@router.put("/mvsep-config")
def set_mvsep_enabled(body: dict, db: Session = Depends(get_db)):
    try:
        team_service.set_mvsep_enabled(bool(body.get("enabled")), _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.put("/mvsep-config/token")
def set_mvsep_token(body: dict, db: Session = Depends(get_db)):
    try:
        team_service.set_mvsep_token(str(body.get("api_token", "")), _active_profile_name(db))
    except PermissionError as e:
        raise HTTPException(403, str(e))
    return {"ok": True}


@router.get("/mvsep-eligible")
def mvsep_eligible(db: Session = Depends(get_db)):
    return {"eligible": team_service.is_credits_eligible(_active_profile_name(db))}


@router.get("/mvsep-models")
def mvsep_models():
    # No secrets in here (labels/sep_type/add_opt1/premium flag only) — safe
    # to expose regardless of eligibility, same as any other model list.
    from ..services import mvsep_service
    return mvsep_service.get_public_categories()


@router.get("/mvsep-balance")
def mvsep_balance(db: Session = Depends(get_db)):
    if not team_service.is_credits_eligible(_active_profile_name(db)):
        raise HTTPException(403, "MVSep недоступний для цього профілю")
    from ..services import mvsep_service
    try:
        return mvsep_service.get_balance()
    except mvsep_service.MVSepError as e:
        raise HTTPException(502, str(e))
