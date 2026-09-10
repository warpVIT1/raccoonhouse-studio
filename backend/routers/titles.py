from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List, Optional

from ..database import get_db
from ..models import AppSettings, Profile, Title, Episode, Character, SignStyle, TitleRoleAssignment
from ..schemas import TitleCreate, TitleUpdate, TitleOut, SignStylesUpdate, TitleRoleAssignmentOut, TitleRoleAssignmentSet
from .episodes import delete_episode_files

router = APIRouter(prefix="/titles", tags=["titles"])

DEFAULT_SIGN_STYLES = ["Sign", "Signs", "OP", "ED"]


def _active_profile_name(db: Session) -> "str | None":
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    return profile.name if profile else None


def _team_name(team_id: "str | None", cache: dict) -> "str | None":
    """Best-effort, never blocks the titles list over a signaling hiccup —
    same posture as everything else that resolves a team name for display
    only. `cache` is a plain dict the caller keeps for the duration of one
    request, since a page of titles routinely repeats the same team_id."""
    if not team_id:
        return None
    if team_id not in cache:
        from ..services import team_service
        try:
            team = team_service.get_team(team_id)
            cache[team_id] = team.get("name") if team else None
        except Exception:
            cache[team_id] = None
    return cache[team_id]


@router.get("/", response_model=List[TitleOut])
def list_titles(db: Session = Depends(get_db)):
    titles = db.query(Title).all()
    # One grouped query instead of one COUNT per title — with N titles this
    # was N separate round trips to SQLite (confirmed the dominant slowdown
    # live 2026-08-20 alongside team_service.get_team's own network calls,
    # see that function's new cache).
    counts = dict(
        db.query(Episode.title_id, func.count(Episode.id)).group_by(Episode.title_id).all()
    )
    result = []
    team_name_cache: dict = {}
    for t in titles:
        out = TitleOut.model_validate(t)
        out.episode_count = counts.get(t.id, 0)
        out.team_name = _team_name(t.team_id, team_name_cache)
        result.append(out)
    return result


@router.post("/", response_model=TitleOut, status_code=201)
def create_title(body: TitleCreate, db: Session = Depends(get_db)):
    data = body.model_dump()
    team_id = data.pop("team_id", None)
    title = Title(**data)
    db.add(title)
    db.flush()
    # Seed default sign styles
    for style_name in DEFAULT_SIGN_STYLES:
        db.add(SignStyle(title_id=title.id, style_name=style_name))
    db.commit()
    db.refresh(title)
    if team_id:
        from ..services import sync_service
        sync_service.share_title(title.id, team_id, db)
        db.refresh(title)
    out = TitleOut.model_validate(title)
    out.episode_count = 0
    out.team_name = _team_name(title.team_id, {})
    return out


@router.get("/{title_id}", response_model=TitleOut)
def get_title(title_id: int, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    ep_count = db.query(func.count(Episode.id)).filter(Episode.title_id == title_id).scalar()
    out = TitleOut.model_validate(title)
    out.episode_count = ep_count or 0
    out.team_name = _team_name(title.team_id, {})
    return out


@router.put("/{title_id}", response_model=TitleOut)
def update_title(title_id: int, body: TitleUpdate, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    # include=model_fields_set, NOT exclude_none=True — same bug fixed in
    # routers/subtitles.py's update_subtitle_line (confirmed live
    # 2026-09-10): exclude_none silently drops a field whose value is None
    # before it ever reaches setattr, so an explicit {field: null} meant to
    # CLEAR a nullable column would silently no-op.
    for k, v in body.model_dump(include=body.model_fields_set).items():
        setattr(title, k, v)
    db.commit()
    db.refresh(title)
    if title.shared_id:
        from ..services import sync_service
        sync_service.push_title(title_id, db)
    ep_count = db.query(func.count(Episode.id)).filter(Episode.title_id == title_id).scalar()
    out = TitleOut.model_validate(title)
    out.episode_count = ep_count or 0
    out.team_name = _team_name(title.team_id, {})
    return out


@router.get("/{title_id}/can-delete-permanently")
def can_delete_permanently(title_id: int, db: Session = Depends(get_db)):
    """Gates whether TitlesPage.tsx even shows the "Видалити назавжди"
    option — same "hide, don't just block" posture as every other admin-
    only control in this app. Personal (non-shared) titles are always
    "yes" here since there's no cloud copy to protect — permanent vs.
    local-only is a meaningless distinction for them."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    if not title.shared_id or not title.team_id:
        return {"can_delete_permanently": True}
    from ..services import team_service
    profile_name = _active_profile_name(db)
    return {"can_delete_permanently": bool(profile_name and team_service.can_manage_team(title.team_id, profile_name))}


@router.delete("/{title_id}", status_code=204)
def delete_title(title_id: int, permanent: bool = False, db: Session = Depends(get_db)):
    """A plain delete only ever removes THIS install's local mirror of a
    shared title — by design, it comes back on the next pull_and_merge (see
    sync_service.py's own comment: a local delete shouldn't destroy a
    teammate's shared work by accident). `permanent=true` (the "Видалити
    назавжди" confirm option — see TitlesPage.tsx) additionally deletes the
    cloud-authoritative shared_titles row itself, so it's gone for the whole
    team, not just this install."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    shared_id, team_id = title.shared_id, title.team_id

    # Gated to the app admin or THAT team's own admin — checked before
    # touching anything, so a denied permanent request never silently
    # downgrades into "well, I deleted your local copy at least" (see
    # TitlesPage.tsx's own "Видалити навсегда" confirm option — only
    # rendered for someone this check would actually allow, but enforced
    # here too since the request is trivial to fire by hand).
    if permanent and shared_id and team_id:
        from ..services import team_service
        profile_name = _active_profile_name(db)
        if not profile_name or not team_service.can_manage_team(team_id, profile_name):
            raise HTTPException(403, "Лише адмін команди або адмін програми може видаляти спільний тайтл назавжди")

        # Cloud delete FIRST, local delete only after it actually succeeds —
        # confirmed live 2026-09-09 as a real "deleted title keeps coming
        # back" bug: this used to delete the local row unconditionally,
        # THEN best-effort try the cloud delete (silently swallowing any
        # failure — network hiccup, transient D1 error, offline
        # signaling). The local copy would already be gone, but the
        # cloud-authoritative shared_titles row survived, so the very next
        # pull_and_merge found no matching local row and recreated it —
        # same "silently downgrades" trap the comment above already
        # guards against for the permission check, just for a network
        # failure instead of a denied permission.
        from ..services import device_identity_service, sync_service
        device_id = device_identity_service.get_profile_id(profile_name)
        if not sync_service.delete_shared_title(shared_id, team_id, device_id, strict=True):
            raise HTTPException(502, "Не вдалося видалити тайтл у хмарі — спробуйте ще раз")

    episode_ids = [row[0] for row in db.query(Episode.id).filter(Episode.title_id == title_id).all()]
    db.delete(title)
    db.commit()
    for ep_id in episode_ids:
        delete_episode_files(ep_id)


def _require_team_manager(title: Title, db: Session) -> None:
    """Shared gate for the "Команда тайтлу" panel — team admin or app admin
    only, same posture as permanent title delete. Raises 403 if denied,
    including for a personal (non-shared) title (nobody to assign roles
    within)."""
    if not title.team_id:
        raise HTTPException(400, "Тайтл не спільний — нема кого призначати")
    from ..services import team_service
    profile_name = _active_profile_name(db)
    if not profile_name or not team_service.can_manage_team(title.team_id, profile_name):
        raise HTTPException(403, "Лише адмін команди або адмін програми може призначати ролі")


@router.get("/{title_id}/role-assignments", response_model=List[TitleRoleAssignmentOut])
def list_title_role_assignments(title_id: int, db: Session = Depends(get_db)):
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    return db.query(TitleRoleAssignment).filter(TitleRoleAssignment.title_id == title_id).all()


@router.put("/{title_id}/role-assignments/{role}", response_model=Optional[TitleRoleAssignmentOut])
def set_title_role_assignment(title_id: int, role: str, body: TitleRoleAssignmentSet, db: Session = Depends(get_db)):
    """Assign (or clear, with device_id=null) who holds `role` for this
    title. Fires the replacement notifications BEFORE touching the row —
    old assignee (if any, and if actually changing) gets told they were
    replaced, new assignee gets told they were assigned — then the row
    itself is updated and pushed to the cloud (see sync_service.py's
    push_title_role_assignment/_unassignment)."""
    title = db.get(Title, title_id)
    if not title:
        raise HTTPException(404, "Title not found")
    _require_team_manager(title, db)

    from ..services import discovery_service, sync_service
    existing = db.query(TitleRoleAssignment).filter(
        TitleRoleAssignment.title_id == title_id, TitleRoleAssignment.role == role,
    ).first()
    old_device_id = existing.device_id if existing else None
    old_name = existing.display_name if existing else None

    if not body.device_id:
        if existing:
            db.delete(existing)
            db.commit()
            if old_device_id:
                discovery_service.notify_device(old_device_id, f"Тебе знято з ролі «{role}» для тайтлу {title.name_ua}.")
            sync_service.push_title_role_unassignment(title_id, role, db)
        return None

    if old_device_id == body.device_id:
        return existing  # no actual change

    if existing:
        existing.device_id = body.device_id
        existing.display_name = body.display_name or body.device_id
    else:
        existing = TitleRoleAssignment(
            title_id=title_id, role=role, device_id=body.device_id, display_name=body.display_name or body.device_id,
        )
        db.add(existing)
    db.commit()
    db.refresh(existing)

    if old_device_id:
        discovery_service.notify_device(
            old_device_id, f"Тебе замінено на {existing.display_name} у ролі «{role}» для тайтлу {title.name_ua}.",
        )
    discovery_service.notify_device(
        body.device_id,
        f"Тебе призначено на роль «{role}» для тайтлу {title.name_ua}"
        + (f" (замість {old_name})." if old_name else "."),
    )
    sync_service.push_title_role_assignment(existing, db)
    return existing


@router.get("/{title_id}/sign-styles")
def get_sign_styles(title_id: int, db: Session = Depends(get_db)):
    styles = db.query(SignStyle).filter(SignStyle.title_id == title_id).all()
    return {"title_id": title_id, "style_names": [s.style_name for s in styles]}


@router.put("/{title_id}/sign-styles")
def update_sign_styles(title_id: int, body: SignStylesUpdate, db: Session = Depends(get_db)):
    db.query(SignStyle).filter(SignStyle.title_id == title_id).delete()
    for name in body.style_names:
        db.add(SignStyle(title_id=title_id, style_name=name.strip()))
    db.commit()
    return {"title_id": title_id, "style_names": body.style_names}
