"""
A fixed, per-machine identity, independent of anything stored in our own
SQLite DB — local profiles (and the whole data/ directory) can get wiped
(reinstall, accidental delete, moving the app) without losing team
membership/admin grants tied to this ID, since it's re-derived identically
from the OS every time rather than generated once and stored by us.

Anchored to Windows' own MachineGuid (HKLM\\SOFTWARE\\Microsoft\\Cryptography),
a real per-Windows-install GUID that predates and outlives this app entirely.
Never exposed raw — hashed with an app-specific salt so nothing external
ever sees the actual MachineGuid (which Windows itself uses for its own
telemetry/licensing purposes, unrelated to us).

get_device_id() alone identifies the MACHINE, not the person — fine for
app-admin purposes (there's exactly one owner-operator machine), but wrong
for team membership: several people can share one studio PC under separate
local Profiles, and they need to be distinguishable to the team system
(confirmed live 2026-08-05 — a second profile on the same PC inherited the
first profile's admin-looking team standing since both hashed to the same
raw device id). get_profile_id() below folds the active profile's NAME into
the hash too, so different profiles on the same machine get different ids,
while still surviving a wipe-and-recreate of that profile as long as it's
recreated under the same name (see routers/profiles.py's optional per-
profile password for the separate concern of gating who can even select a
given profile at all).
"""
import hashlib
import os
import winreg

_SALT = "raccoonhouse-studio-device-id-v1"

_cached_id: "str | None" = None


def _read_machine_guid() -> str:
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography") as key:
        value, _ = winreg.QueryValueEx(key, "MachineGuid")
        return str(value)


def get_device_id() -> str:
    """A stable ~16-char hex ID, the same every time on this machine, safe
    to publish (it's a one-way hash, not the raw MachineGuid). Identifies
    the MACHINE only — see get_profile_id() for the per-person id used by
    everything team-related.

    RH_DEVICE_ID_OVERRIDE, if set, replaces the real MachineGuid-derived
    value outright — a dev/testing knob only (not exposed in Settings), for
    simulating two genuinely distinct machines (including distinct app-admin
    status, see team_service.APP_ADMIN_DEVICE_IDS) on one physical PC by
    launching a second install directory with this set."""
    override = os.environ.get("RH_DEVICE_ID_OVERRIDE")
    if override:
        return override
    global _cached_id
    if _cached_id is not None:
        return _cached_id
    try:
        raw = _read_machine_guid()
    except OSError:
        # Only plausible on a locked-down/non-standard Windows install where
        # this registry key is unreadable — extremely rare. Falls back to a
        # random id for this process only; team/credit features simply won't
        # persist correctly across restarts on such a machine, which is a
        # reasonable degradation rather than a crash.
        import uuid
        raw = str(uuid.uuid4())
    digest = hashlib.sha256(f"{_SALT}:{raw}".encode("utf-8")).hexdigest()
    _cached_id = digest[:16]
    return _cached_id


def get_profile_id(profile_name: str) -> str:
    """The id used for everything team-related (membership, invites,
    credit grants) — this machine's id PLUS the active profile's name, so
    two people sharing one PC under different profiles get different ids.
    Recreating a wiped profile under the same name reproduces the exact
    same id, same resilience property as get_device_id() alone had."""
    normalized = profile_name.strip().lower()
    digest = hashlib.sha256(f"{_SALT}:{get_device_id()}:{normalized}".encode("utf-8")).hexdigest()
    return digest[:16]
