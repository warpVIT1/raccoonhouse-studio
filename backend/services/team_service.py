"""
Team system — global (Cloudflare D1-backed, see cloudflare-signaling/schema.sql),
unlike Profile which is local-only. Membership/admin rights key off
device_identity_service.get_profile_id(profile_name) — the machine id PLUS
the active local Profile's name — not a bare machine id, so two people
sharing one studio PC under different profiles get distinct team standing
(confirmed live 2026-08-05: a second profile inherited the first's team
membership when this only hashed the machine). A wiped local profile still
recovers the same team standing as long as it's recreated under the same
name.

Only the app admin (see is_app_admin below — tied to the LOCAL profile's
own admin role, Profile.is_admin) can create a team — its creator becomes
the team's first team admin automatically. Team admins can only invite/
remove members of their OWN team; nothing here lets a team admin touch
another team or create new ones. The app admin can act on any team.

App-admin status used to be a hardcoded allowlist of specific
device_identity_service ids (one per trusted machine+profile-name
combination) — deliberately profile-scoped rather than machine-scoped, so
some OTHER local profile on the same PC wouldn't automatically inherit
admin visibility over every team just by being on the owner's hardware.
That held up until a real production profile ("warpVIT") hashed to a
DIFFERENT id than the differently-named test profile ("2") the allowlist
had actually been captured from, on the very same physical machine — the
allowlist silently didn't match its own owner (confirmed live 2026-08-09,
shipped broken in 1.0.4). Tying this to Profile.is_admin instead needs no
id to keep in sync: whichever local profile is marked admin (see
ProfileModal's "type admin as your role → enter password" flow) already
carries the app-admin role directly with it. Trade-off worth knowing:
Profile.is_admin is explicitly NOT real security (see its own comment in
models.py) — anyone with local API access to this machine could flip it —
so this makes team creation/credit-granting only as hard to reach as that
same convenience gate, not a separate harder one.
"""
import json
import time
from typing import Optional

import requests

from . import device_identity_service, discovery_service
from .password_service import hash_password, verify_password

# get_team is called once per distinct team on EVERY titles-list page load
# (see routers/titles.py's list_titles) — with no cache, that's a real
# blocking HTTP round trip (up to the 15s timeout below) to the Worker on
# every single navigation to Titles, confirmed live 2026-08-20 as a real
# slowdown. A team's name changes rarely, so a few minutes of staleness
# here is a non-issue for either of get_team's two callers (both display-
# only — see actor_video_service.py and titles.py's own per-request cache,
# which this sits underneath and complements, not replaces).
_TEAM_CACHE: dict[str, tuple[float, "dict | None"]] = {}
_TEAM_CACHE_TTL_SECONDS = 300

# The studio owner's real Telegram account — always treated as app admin
# regardless of what Profile.is_admin happens to say. Both previous designs
# (a hardcoded device_identity_service id allowlist, then a plain
# Profile.is_admin flag — see this module's own docstring above) turned out
# fragile: the device-id allowlist silently stopped matching its own owner
# after a profile rename (shipped broken in 1.0.4), and is_admin gets
# silently clobbered back to False by ANY `PUT /profiles/{id}` that round-
# trips a stale in-memory copy of the profile (confirmed live 2026-08-17 —
# editing roles/color while a window had a pre-grant snapshot cached wiped
# the flag right back). telegram_id doesn't have either failure mode: it's
# immutable once linked and never touched by a plain profile-field edit, so
# checking it here means the owner's admin status self-heals on the very
# next request instead of staying wiped until someone notices and re-grants
# it by hand.
OWNER_TELEGRAM_ID = 1210501019


def is_admin_profile(profile) -> bool:
    """Shared by every admin check in the app (this module's is_app_admin,
    routers/profiles.py, routers/power_share.py, routers/model_browser.py)
    so the owner-telegram-id override lives in exactly one place — see
    OWNER_TELEGRAM_ID's own comment above for why this exists alongside
    the plain is_admin flag rather than replacing it."""
    return bool(profile and (profile.is_admin or profile.telegram_id == OWNER_TELEGRAM_ID))


def is_app_admin(profile_name: str) -> bool:
    from ..database import SessionLocal
    from ..models import Profile
    db = SessionLocal()
    try:
        profile = db.query(Profile).filter(Profile.name == profile_name).first()
        return is_admin_profile(profile)
    finally:
        db.close()


def _base() -> str:
    base = discovery_service.get_https_base()
    if not base:
        raise RuntimeError("Онлайн-синхронізація вимкнена або недоступна")
    return base


def create_team(name: str, password: str, credits_enabled: bool, profile_name: str) -> dict:
    if not is_app_admin(profile_name):
        raise PermissionError("Тільки адмін програми може створювати команди")
    import uuid
    team_id = uuid.uuid4().hex[:16]
    resp = requests.post(f"{_base()}/teams", json={
        "id": team_id,
        "name": name,
        "password_hash": hash_password(password),
        "credits_enabled": credits_enabled,
        "created_by_device_id": device_identity_service.get_profile_id(profile_name),
    }, timeout=15)
    resp.raise_for_status()
    return resp.json()


def list_teams(profile_name: str) -> list[dict]:
    """The full team roster — app-admin only. Regular team admins/members
    must not be able to browse teams they're not in (see find_team_by_name
    for how a regular user joins one they already know the name of)."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми бачить усі команди")
    resp = requests.get(f"{_base()}/teams", timeout=15)
    resp.raise_for_status()
    return resp.json()


def admin_preview_team_content(team_id: str, profile_name: str) -> list[dict]:
    """App-admin-only "look into any team's box" — a plain passthrough to
    the Worker's own GET /shared-titles?team_id=X (the exact same snapshot
    sync_service.pull_and_merge fetches for a real sync), but returned
    as-is and NEVER written to local SQLite. Works for a team the admin
    isn't even a member of, same as list_teams above — the Worker route
    has no membership check, only pull_and_merge's own local-write side
    ever scoped this to "your own teams" before. Read-only by
    construction: nothing here calls a notify_*/push_* function, so the
    team being looked at has no way to know."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми може переглядати вміст команди")
    resp = requests.get(f"{_base()}/shared-titles", params={"team_id": team_id}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def find_team_by_name(name: str) -> "dict | None":
    """Resolves a team the caller already knows the exact name of, without
    exposing any OTHER team's existence — used by join_team below. Returns
    None (not the whole list) if there's no exact match."""
    resp = requests.get(f"{_base()}/teams/by-name", params={"name": name}, timeout=15)
    if resp.status_code == 404:
        return None
    resp.raise_for_status()
    return resp.json()


def get_team(team_id: str) -> "dict | None":
    """A single team's public info by id — unlike list_teams(), not
    app-admin-gated, since a team admin needs this for their OWN team (e.g.
    to name-drop it in an invite notification) without being able to browse
    every other team via the same call. Cached for a few minutes — see
    _TEAM_CACHE's own comment."""
    cached = _TEAM_CACHE.get(team_id)
    if cached and time.monotonic() - cached[0] < _TEAM_CACHE_TTL_SECONDS:
        return cached[1]
    resp = requests.get(f"{_base()}/teams/by-id", params={"team_id": team_id}, timeout=15)
    if resp.status_code == 404:
        _TEAM_CACHE[team_id] = (time.monotonic(), None)
        return None
    resp.raise_for_status()
    team = resp.json()
    _TEAM_CACHE[team_id] = (time.monotonic(), team)
    return team


def delete_team(team_id: str, profile_name: str) -> None:
    # App-admin only, same as create_team — deleting a whole team (and
    # everyone's membership in it) is a bigger action than a team admin
    # removing one member, so it isn't delegated to team admins the way
    # invite/remove-member are.
    if not is_app_admin(profile_name):
        raise PermissionError("Тільки адмін програми може видаляти команди")
    resp = requests.delete(f"{_base()}/teams/{team_id}", timeout=15)
    resp.raise_for_status()


def set_team_credits(team_id: str, enabled: bool, profile_name: str) -> None:
    # App-admin only — the whole point of this flag is "which teams the app
    # admin has decided get paid credit access," so it can't be delegated to
    # a team admin (who could otherwise just flip it on for their own team).
    if not is_app_admin(profile_name):
        raise PermissionError("Тільки адмін програми керує кредитністю команди")
    resp = requests.put(f"{_base()}/teams/{team_id}/credits", json={"enabled": enabled}, timeout=15)
    resp.raise_for_status()


def my_teams(profile_name: str) -> list[dict]:
    resp = requests.get(
        f"{_base()}/teams/my-teams", params={"device_id": device_identity_service.get_profile_id(profile_name)}, timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def team_members(team_id: str) -> list[dict]:
    resp = requests.get(f"{_base()}/teams/members", params={"team_id": team_id}, timeout=15)
    resp.raise_for_status()
    return resp.json()


def list_team_actors(team_id: str, role: str = "actor") -> list[dict]:
    """Team members holding a given job-title role — defaults to 'actor'
    (feeds the subtitle grid's АКТОР dropdown), also reused since
    2026-08-19 for the title "Команда тайтлу" panel's per-role assignment
    dropdowns. See Worker's GET /team-actors."""
    resp = requests.get(f"{_base()}/team-actors", params={"team_id": team_id, "role": role}, timeout=15)
    resp.raise_for_status()
    return resp.json()


def _is_team_admin_of(team_id: str, profile_name: str) -> bool:
    if is_app_admin(profile_name):
        return True
    own_id = device_identity_service.get_profile_id(profile_name)
    return any(m["device_id"] == own_id and m["is_team_admin"] for m in team_members(team_id))


def can_manage_team(team_id: str, profile_name: str) -> bool:
    """Public alias of _is_team_admin_of — app admin OR that specific
    team's own admin. Used to gate the permanent (cloud-wide) title delete
    (see routers/titles.py's delete_title) — an ordinary team member can
    still remove their own local copy of a shared title, just not delete
    it out from under the whole team."""
    return _is_team_admin_of(team_id, profile_name)


def join_team(name: str, password: str, display_name: str, profile_name: str) -> None:
    """Direct join by TYPING the team's exact name + its password — separate
    from the invite-by-id flow below; either path is valid, matching how the
    user described both "type the team name + password" AND "team admin
    invites by id" as intended entry points. Deliberately takes a name, not
    a team_id — a regular user must not be able to browse/discover other
    teams via this call, only resolve one they already know the name of
    (see find_team_by_name). Implemented as a self-created, self-accepted
    invite so membership always goes through the one Worker-side code path
    (/teams/invites + /teams/invites/respond) regardless of entry method,
    rather than a separate direct-insert route."""
    team = find_team_by_name(name)
    if not team:
        raise ValueError("Команду не знайдено")
    team_id = team["id"]
    if not verify_password(password, team["password_hash"]):
        raise PermissionError("Невірний пароль команди")

    own_id = device_identity_service.get_profile_id(profile_name)
    invite_resp = requests.post(f"{_base()}/teams/invites", json={
        "team_id": team_id, "invited_device_id": own_id, "created_by_device_id": own_id,
    }, timeout=15)
    invite_resp.raise_for_status()
    invite_id = invite_resp.json()["id"]

    accept_resp = requests.post(f"{_base()}/teams/invites/respond", json={
        "invite_id": invite_id, "accept": True, "display_name": display_name,
    }, timeout=15)
    accept_resp.raise_for_status()


def invite_member(team_id: str, invited_device_id: str, profile_name: str) -> dict:
    if not _is_team_admin_of(team_id, profile_name):
        raise PermissionError("Лише адмін команди може запрошувати")
    own_id = device_identity_service.get_profile_id(profile_name)
    resp = requests.post(f"{_base()}/teams/invites", json={
        "team_id": team_id, "invited_device_id": invited_device_id, "created_by_device_id": own_id,
    }, timeout=15)
    resp.raise_for_status()
    invite = resp.json()
    # Immediate delivery if the invited device is online right now (see
    # discovery_service._handle_relay's "team_invite" kind on the receiving
    # end) — falls back to the durable /teams/invites row above for whenever
    # they next connect if they're offline right now.
    team = get_team(team_id)
    team_name = team["name"] if team else team_id
    discovery_service.send_relay(invited_device_id, {
        "kind": "team_invite", "invite_id": invite["id"], "team_id": team_id, "team_name": team_name,
    })
    return invite


def pending_invites(profile_name: str) -> list[dict]:
    resp = requests.get(
        f"{_base()}/teams/invites", params={"device_id": device_identity_service.get_profile_id(profile_name)}, timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def respond_to_invite(invite_id: str, accept: bool, display_name: str) -> None:
    resp = requests.post(f"{_base()}/teams/invites/respond", json={
        "invite_id": invite_id, "accept": accept, "display_name": display_name,
    }, timeout=15)
    resp.raise_for_status()


def remove_member(team_id: str, device_id: str, profile_name: str) -> None:
    # Removing yourself (leaving the team) is always allowed, regardless of
    # admin status — only removing SOMEONE ELSE needs team-admin/app-admin.
    own_id = device_identity_service.get_profile_id(profile_name)
    if device_id != own_id and not _is_team_admin_of(team_id, profile_name):
        raise PermissionError("Лише адмін команди може видаляти учасників")
    resp = requests.delete(f"{_base()}/teams/members", params={"team_id": team_id, "device_id": device_id}, timeout=15)
    resp.raise_for_status()


def set_member_roles(team_id: str, device_id: str, roles: list[str], profile_name: str) -> None:
    """Job-title roles (актор/режисер/etc.) are no longer self-picked
    (2026-09-09 — see ProfileModal.tsx/SettingsPage.tsx's removed
    <RolePicker> self-edit spots, and models.py's Profile.roles default of
    just ["actor"]) — a team admin (or the app admin) grants them here
    instead. Unlike set_team_admin above, THIS one IS delegated to team
    admins, same posture as invite/remove-member — an ordinary studio lead
    assigning "this person is now our translator" is routine team
    management, not the entrenchment risk admin-promotion is. Worker's own
    PUT /known-devices/:id/roles double-checks BOTH that profile_name is
    really a team admin of team_id AND that the target device_id is really
    a member of team_id — this local check is the friendly early error,
    that one is the actual enforcement."""
    if not _is_team_admin_of(team_id, profile_name):
        raise PermissionError("Лише адмін команди може змінювати ролі учасників")
    own_id = device_identity_service.get_profile_id(profile_name)
    resp = requests.put(f"{_base()}/known-devices/{device_id}/roles", json={
        "roles": roles, "team_id": team_id, "admin_device_id": own_id,
    }, timeout=15)
    resp.raise_for_status()


def rename_team(team_id: str, new_name: str, profile_name: str) -> None:
    """Fixes a typo'd/outdated team name (2026-09-09, e.g. "RaccoonHause" ->
    "RaccoonHouse") without recreating the team — delegated to team admins,
    same posture as set_member_roles/invite/remove-member above (routine
    team management, not the entrenchment risk set_team_admin guards
    against)."""
    if not _is_team_admin_of(team_id, profile_name):
        raise PermissionError("Лише адмін команди може перейменувати команду")
    resp = requests.put(f"{_base()}/teams/{team_id}/name", json={"name": new_name}, timeout=15)
    if resp.status_code == 409:
        raise ValueError("Ця назва вже зайнята")
    resp.raise_for_status()


def set_team_admin(team_id: str, device_id: str, is_admin: bool, profile_name: str) -> None:
    # App-admin only — deliberately NOT delegated to team admins (unlike
    # invite/remove-member, which they DO get). A team admin promoting their
    # own replacements would let them entrench control of a team the app
    # admin never granted them full authority over.
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми може призначати тім-адмінів")
    resp = requests.put(f"{_base()}/teams/members/admin", json={
        "team_id": team_id, "device_id": device_id, "is_team_admin": is_admin,
    }, timeout=15)
    resp.raise_for_status()


def get_server_stats(profile_name: str) -> dict:
    """"How loaded is the server" (2026-09-09, Settings -> Адмін tab, app
    admin only) — proxies the Worker's GET /admin/db-stats, which reports
    both the D1 sync-metadata database's own size (db_bytes, tiny — titles/
    episodes/subtitle rows only) and the R2 transfer bucket's real size
    (r2_bytes/r2_object_count/percent_of_free_tier — this is where actual
    video/audio content lives while in transit between studio PCs, and the
    number that actually reflects "how full," confirmed live 2026-09-09
    after the D1-only number read as implausibly small with real episode
    video/audio already uploaded). Not literal RAM — this app has no
    persistent server process with its own memory footprint to report."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми бачить статистику сервера")
    resp = requests.get(f"{_base()}/admin/db-stats", timeout=15)
    resp.raise_for_status()
    return resp.json()


def all_known_users(profile_name: str) -> list[dict]:
    """Every device_id that's ever appeared as a member of any team,
    deduplicated, with its credit-grant status folded in — feeds the
    app-admin-only "Користувачі" tab. Base list is EVERY device that's ever
    said hello to the signaling Worker (known_devices — see its own schema
    comment), regardless of team membership; team_members is cross-
    referenced separately to attach a team name to whoever has one, so
    someone in no team at all still shows up (with no team next to them)
    instead of being invisible.

    credits_enabled is TRUE automatically for anyone in a credits_enabled
    team — that's the whole point of marking a team credits_enabled (see
    set_team_credits) — with the per-person grant in credit_grants only
    relevant (and only shown as an editable toggle by the frontend) for
    someone who ISN'T in such a team, as an individual exception."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми бачить базу користувачів")
    devices = requests.get(f"{_base()}/known-devices", timeout=15)
    devices.raise_for_status()
    def _parse_roles(raw) -> list:
        try:
            return json.loads(raw) if raw else []
        except (TypeError, ValueError):
            return []

    by_device: dict[str, dict] = {
        d["device_id"]: {
            "device_id": d["device_id"], "display_name": d["display_name"], "teams": [],
            "credits_from_team": False, "telegram_id": d.get("telegram_id"),
            "telegram_username": d.get("telegram_username"), "roles": _parse_roles(d.get("roles")),
            "first_seen_at": d.get("first_seen_at"), "last_seen_at": d.get("last_seen_at"),
        }
        for d in devices.json()
    }
    for team in list_teams(profile_name):
        for m in team_members(team["id"]):
            entry = by_device.setdefault(m["device_id"], {
                "device_id": m["device_id"], "display_name": m["display_name"], "teams": [],
                "credits_from_team": False, "telegram_id": None,
                "telegram_username": None, "roles": [], "first_seen_at": None, "last_seen_at": None,
            })
            entry["display_name"] = m["display_name"]
            entry["teams"].append({"team_id": team["id"], "team_name": team["name"], "is_team_admin": bool(m["is_team_admin"])})
            if team.get("credits_enabled"):
                entry["credits_from_team"] = True
    grants = {g["device_id"]: bool(g["enabled"]) for g in list_credit_grants()}
    for device_id, entry in by_device.items():
        entry["credits_enabled"] = entry["credits_from_team"] or grants.get(device_id, False)
    return list(by_device.values())


def delete_known_user(device_id: str, profile_name: str) -> None:
    """Precise per-user cleanup for the admin "База даних" tab — removes
    just this device's identity + team memberships + credit grant + any
    invites (see the Worker's DELETE /known-devices/:id), NOT any
    shared_titles/episodes/characters/subtitle_lines content. Exists so
    QA/test profiles don't pile up in the shared production D1 after a
    testing session, without risking real teams' shared content — the
    user explicitly wanted per-user precision here, not a single
    wipe-everything button."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми може видаляти користувачів")
    resp = requests.delete(f"{_base()}/known-devices/{device_id}", timeout=15)
    resp.raise_for_status()


def get_notifications_paused() -> bool:
    resp = requests.get(f"{_base()}/notification-settings", timeout=15)
    resp.raise_for_status()
    return bool(resp.json().get("paused"))


def set_notifications_paused(paused: bool, profile_name: str) -> dict:
    """Global kill switch for automated Telegram notifications (stage-
    handoff pings, per-actor SRT handoff) — Settings' admin tab. Does NOT
    affect an admin's own manually-composed message (team_service.
    send_message_to_user) or /feedback — see the Worker's
    areNotificationsPaused comment. Flipping it also broadcasts a one-time
    "paused"/"resumed" notice to everyone Telegram-linked, handled entirely
    server-side (see PUT /notification-settings) so it isn't itself
    swallowed by the very pause it announces."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми керує сповіщеннями")
    resp = requests.put(f"{_base()}/notification-settings", json={"paused": paused}, timeout=30)
    resp.raise_for_status()
    return resp.json()


def list_credit_grants() -> list[dict]:
    resp = requests.get(f"{_base()}/credit-grants", timeout=15)
    resp.raise_for_status()
    return resp.json()


def set_credit_grant(device_id: str, enabled: bool, profile_name: str) -> None:
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми керує доступом до кредитів")
    resp = requests.put(f"{_base()}/credit-grants", json={
        "device_id": device_id, "enabled": enabled,
        "granted_by_device_id": device_identity_service.get_profile_id(profile_name),
    }, timeout=15)
    resp.raise_for_status()


def send_message_to_user(device_id: str, message: str, profile_name: str) -> int:
    """Direct admin -> any known user Telegram message (see the "Користувачі"
    tab) — separate from notify_director's team-role broadcast, this targets
    one specific device_id by hand. Returns 1 if delivered (the target has a
    telegram_id on file), 0 otherwise (see the Worker's /notify-device)."""
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми може писати користувачам")
    resp = requests.post(f"{_base()}/notify-device", json={
        "device_id": device_id, "message": message,
    }, timeout=15)
    resp.raise_for_status()
    return resp.json()["sent"]


def get_mvsep_public_config() -> dict:
    """What the frontend is allowed to see — never api_token (see
    mvsep_service.get_config for the internal, token-included version used
    to actually call MVSep)."""
    resp = requests.get(f"{_base()}/mvsep-config", timeout=15)
    resp.raise_for_status()
    data = resp.json()
    return {"enabled": bool(data.get("enabled")), "configured": bool(data.get("api_token"))}


def is_credits_eligible(profile_name: str) -> bool:
    """Whether THIS profile can actually use MVSep credits right now —
    combines the global kill-switch with per-person/per-team eligibility.
    The app admin is always eligible when the switch is on, same "can act
    on anything" posture as everywhere else in this module."""
    config = get_mvsep_public_config()
    if not config["enabled"]:
        return False
    if is_app_admin(profile_name):
        return True
    own_id = device_identity_service.get_profile_id(profile_name)
    for t in my_teams(profile_name):
        if t.get("credits_enabled"):
            return True
    grants = {g["device_id"]: bool(g["enabled"]) for g in list_credit_grants()}
    return grants.get(own_id, False)


def set_mvsep_enabled(enabled: bool, profile_name: str) -> None:
    # Master kill-switch, app-admin only — see the Worker's /mvsep-config
    # comment for why this exists on top of team/person-level eligibility.
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми керує кредитами MVSep")
    resp = requests.put(f"{_base()}/mvsep-config", json={"enabled": enabled}, timeout=15)
    resp.raise_for_status()


def set_mvsep_token(api_token: str, profile_name: str) -> None:
    if not is_app_admin(profile_name):
        raise PermissionError("Лише адмін програми керує MVSep")
    resp = requests.put(f"{_base()}/mvsep-config", json={"api_token": api_token}, timeout=15)
    resp.raise_for_status()
