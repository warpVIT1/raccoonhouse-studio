from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from typing import List

from ..database import get_db
from ..models import Profile, AppSettings, RoleCatalog
from ..schemas import ProfileActivateIn, ProfileCreate, ProfileOut, RoleCatalogCreate, RoleCatalogItem
from ..services.password_service import hash_password as _hash_password, verify_password as _verify_password
from ..services import telegram_login_service
from ..services.team_service import is_admin_profile

router = APIRouter(tags=["profiles"])


def _active_profile_is_admin(db: Session) -> bool:
    settings = db.get(AppSettings, 1)
    profile = db.get(Profile, settings.active_profile_id) if settings and settings.active_profile_id else None
    return is_admin_profile(profile)


def _out(profile: Profile) -> ProfileOut:
    # The owner's telegram_id always counts as admin even if the stored
    # column says otherwise — see team_service.is_admin_profile's own
    # comment. Applied here (every response site) rather than relying on
    # FastAPI's automatic response_model conversion, so the UI never shows
    # the raw, possibly-stale flag.
    out = ProfileOut.model_validate(profile)
    out.is_admin = is_admin_profile(profile)
    return out


@router.get("/profiles", response_model=List[ProfileOut])
def list_profiles(db: Session = Depends(get_db)):
    return [_out(p) for p in db.query(Profile).all()]


@router.post("/profiles", response_model=ProfileOut, status_code=201)
def create_profile(body: ProfileCreate, db: Session = Depends(get_db)):
    data = body.model_dump()
    password = data.pop("password", None)
    # Server-side default, not just the frontend's own (2026-09-09): every
    # new profile starts as a plain actor regardless of what a client sends
    # — a team admin grants anything beyond that later (see team_service.
    # set_member_roles), self-service escalation on creation is exactly
    # what this whole change was meant to close off.
    if not data.get("roles"):
        data["roles"] = ["actor"]
    profile = Profile(**data)
    if password:
        profile.password_hash = _hash_password(password)
    db.add(profile)
    db.commit()
    db.refresh(profile)
    return _out(profile)


@router.put("/profiles/{profile_id}", response_model=ProfileOut)
def update_profile(profile_id: int, body: ProfileCreate, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404)
    data = body.model_dump()
    password = data.pop("password", None)
    for k, v in data.items():
        setattr(profile, k, v)
    # None = leave the existing password (if any) untouched; an empty
    # string is how the frontend asks to clear it; anything else sets a new one.
    if password:
        profile.password_hash = _hash_password(password)
    elif password == "":
        profile.password_hash = None
    db.commit()
    db.refresh(profile)
    return _out(profile)


@router.delete("/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: int, db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404)
    db.delete(profile)
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id == profile_id:
        settings.active_profile_id = None
    db.commit()


@router.post("/profiles/{profile_id}/activate", response_model=ProfileOut)
def activate_profile(profile_id: int, body: ProfileActivateIn = ProfileActivateIn(), db: Session = Depends(get_db)):
    profile = db.get(Profile, profile_id)
    if not profile:
        raise HTTPException(404)
    if profile.password_hash and not (body.password and _verify_password(body.password, profile.password_hash)):
        raise HTTPException(403, "Невірний пароль профілю")
    settings = db.get(AppSettings, 1)
    if not settings:
        settings = AppSettings(id=1)
        db.add(settings)
    settings.active_profile_id = profile_id
    db.commit()
    return _out(profile)


@router.post("/profiles/refresh-roles", response_model=ProfileOut)
def refresh_own_roles(db: Session = Depends(get_db)):
    """Immediate on-demand version of sync_service.pull_own_roles's own
    periodic pull (which otherwise only runs once on connect + every ~5
    minutes — confirmed live 2026-09-09 as a real "my role change doesn't
    seem to apply" complaint, since a team admin editing their OWN roles
    via TeamsPage had to wait out that whole interval to see it reflected
    anywhere that reads Profile.roles, e.g. EpisodeRoleRouter's tab list).
    Called right after TeamsPage.tsx's saveMemberRoles succeeds, but only
    when the edited device IS the caller's own — editing someone else's
    roles has nothing for THIS device to refresh."""
    settings = db.get(AppSettings, 1)
    if not settings or not settings.active_profile_id:
        raise HTTPException(400, "No active profile")
    from ..services.sync_service import pull_own_roles
    pull_own_roles(db)
    profile = db.get(Profile, settings.active_profile_id)
    return _out(profile)


@router.get("/role-catalog", response_model=List[RoleCatalogItem])
def list_role_catalog(db: Session = Depends(get_db)):
    # Not admin-gated — every profile needs this list just to render the
    # multi-select in ProfileModal, same as everyone can always see the
    # local Dubber/character lists.
    return db.query(RoleCatalog).order_by(RoleCatalog.sort_order, RoleCatalog.id).all()


@router.post("/role-catalog", response_model=RoleCatalogItem, status_code=201)
def add_role_catalog_item(body: RoleCatalogCreate, db: Session = Depends(get_db)):
    # Admin-gated (unlike the GET above) — same "hide, don't just block"
    # posture as the rest of the app's admin-only editing surfaces (Апекс's
    # line-up, teams, credits): everyone sees the current roles, only an
    # admin can change what the set itself contains.
    if not _active_profile_is_admin(db):
        raise HTTPException(403, "Лише адмін може редагувати список ролей")
    key = body.key.strip().lower().replace(" ", "_")
    if not key or not body.label.strip():
        raise HTTPException(400, "Вкажіть ключ і назву ролі")
    if db.query(RoleCatalog).filter(RoleCatalog.key == key).first():
        raise HTTPException(409, "Роль з таким ключем вже існує")
    max_order = db.query(RoleCatalog).count()
    item = RoleCatalog(key=key, label=body.label.strip(), sort_order=max_order)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@router.delete("/role-catalog/{key}", status_code=204)
def delete_role_catalog_item(key: str, db: Session = Depends(get_db)):
    if not _active_profile_is_admin(db):
        raise HTTPException(403, "Лише адмін може редагувати список ролей")
    item = db.query(RoleCatalog).filter(RoleCatalog.key == key).first()
    if not item:
        raise HTTPException(404)
    db.delete(item)
    # Deliberately does NOT touch any Profile.roles that still reference this
    # key — a profile keeps whatever it already had, same as a Dubber
    # keeping a character mapping after other data changes elsewhere; the
    # frontend just won't offer this key as pickable going forward, and
    # simply won't find a label for it on profiles that still carry it.
    db.commit()


@router.post("/profiles/telegram-login/start")
def telegram_login_start():
    try:
        return telegram_login_service.start_login()
    except telegram_login_service.TelegramLoginError as e:
        raise HTTPException(502, str(e))


@router.get("/profiles/telegram-login/poll")
def telegram_login_poll(code: str, roles: str = "", db: Session = Depends(get_db)):
    try:
        data = telegram_login_service.poll_login(code)
    except telegram_login_service.TelegramLoginError as e:
        raise HTTPException(410, str(e))
    if data is None:
        return {"status": "pending"}

    telegram_id = data["telegram_id"]
    profile = db.query(Profile).filter(Profile.telegram_id == telegram_id).first()
    display_name = data.get("first_name") or data.get("username") or f"tg{telegram_id}"
    if profile:
        # Refresh avatar/username on every login — Telegram profile photos
        # and @usernames change over time, and this poll is the only place
        # that ever re-syncs them (see Profile.avatar_url's comment: always
        # fetched fresh from Telegram, never downloaded/cached locally).
        # Deliberately does NOT touch .roles on a repeat login — the person
        # picks roles once, at first sign-in (see ProfileModal.tsx's "Ваша
        # роль у студії" picker, shown before the Telegram button); an
        # admin may have since changed them, and a repeat login shouldn't
        # silently clobber that.
        profile.telegram_username = data.get("username") or None
        profile.avatar_url = data.get("photo_url") or None
    else:
        profile = Profile(
            name=display_name,
            telegram_id=telegram_id,
            telegram_username=data.get("username") or None,
            avatar_url=data.get("photo_url") or None,
            # Server-side default, same reasoning as create_profile above —
            # "actor" if the client sent nothing usable.
            roles=[r for r in roles.split(",") if r] or ["actor"],
        )
        db.add(profile)
    db.commit()
    db.refresh(profile)

    # A successful Telegram login IS the authentication — stronger proof of
    # identity than this app's own optional per-profile password (see
    # Profile.password_hash's comment: "not real security"), so it always
    # activates immediately rather than also demanding that local password.
    settings = db.get(AppSettings, 1)
    if not settings:
        settings = AppSettings(id=1)
        db.add(settings)
    settings.active_profile_id = profile.id
    db.commit()

    return {"status": "done", "profile": _out(profile).model_dump()}
