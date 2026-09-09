"""
Pre-update safety net for personal (non-"Спільний з командою") data —
titles/episodes/subtitle-lines/markers/characters that never reach the
cloud at all (unlike shared titles, which self-heal from D1 via
sync_service.pull_and_merge). Fully automatic, no retention policy: a
single backup file is written right before an update installs (see
electron/main.ts's before-quit handler, which calls POST /backup/create),
then silently restored and deleted on the very next launch (see
restore_and_cleanup_backup, called unconditionally from database.py's
init_db() — same self-healing-on-startup posture as
_sync_missing_columns/_repair_stale_episode_paths/_seed_default_roles).

Also backs up Profile/RoleCatalog (small, and flagged at-risk in the same
session's own profile-persistence audit) alongside the personal titles.
"""
import json
import lzma
import os
import shutil
from datetime import datetime
from sqlalchemy.orm import Session

from ..models import AppSettings, AssStyleDef, Character, Episode, Marker, Profile, RoleCatalog, SubtitleLine, Title

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
BACKUP_FILENAME = "raccoonhouse-backup.xz"

# Set once by restore_and_cleanup_backup during init_db(), which runs
# synchronously before the HTTP server starts listening — routers/backup.py's
# GET /backup/status reads this back so the renderer can toast on first load
# after an update, without needing to re-run the (destructive-if-repeated)
# restore itself.
_last_restore_result: "dict | None" = None


def get_backup_dir(db: Session) -> str:
    """Resolves, in priority order: (a) AppSettings.backup_directory, a
    later Settings-page override; (b) the NSIS installer's one-time
    choice, written to a plain marker file next to the exe (see
    resources/installer.nsh's customPageAfterChangeDir — DATA_DIR is
    always <installdir>/data in a packaged build, so its parent IS the
    install dir); (c) a fixed fallback so the feature still works on an
    install that predates the NSIS page or skipped it."""
    settings = db.get(AppSettings, 1)
    if settings and settings.backup_directory:
        return settings.backup_directory

    install_dir = os.path.dirname(DATA_DIR)
    marker_path = os.path.join(install_dir, "backup-location.txt")
    if os.path.isfile(marker_path):
        try:
            with open(marker_path, "r", encoding="utf-8") as f:
                chosen = f.readline().strip()
            if chosen:
                return chosen
        except OSError:
            pass

    return os.path.join(os.environ.get("LOCALAPPDATA", DATA_DIR), "RaccoonHouse", "backups")


def _collect_personal_data(db: Session) -> dict:
    titles = db.query(Title).filter(Title.shared_id.is_(None)).all()
    title_ids = [t.id for t in titles]

    episodes = db.query(Episode).filter(Episode.title_id.in_(title_ids)).all() if title_ids else []
    episode_ids = [e.id for e in episodes]
    characters = db.query(Character).filter(Character.title_id.in_(title_ids)).all() if title_ids else []
    lines = db.query(SubtitleLine).filter(SubtitleLine.episode_id.in_(episode_ids)).all() if episode_ids else []
    markers = db.query(Marker).filter(Marker.episode_id.in_(episode_ids)).all() if episode_ids else []
    ass_styles = db.query(AssStyleDef).filter(AssStyleDef.episode_id.in_(episode_ids)).all() if episode_ids else []

    def _cols(row) -> dict:
        return {c.name: getattr(row, c.name) for c in row.__table__.columns}

    def _serial(row) -> dict:
        out = {}
        for k, v in _cols(row).items():
            out[k] = v.isoformat() if isinstance(v, datetime) else v
        return out

    return {
        "version": 1,
        "created_at": datetime.utcnow().isoformat(),
        "titles": [_serial(t) for t in titles],
        "episodes": [_serial(e) for e in episodes],
        "characters": [_serial(c) for c in characters],
        "subtitle_lines": [_serial(l) for l in lines],
        "markers": [_serial(m) for m in markers],
        "ass_style_defs": [_serial(a) for a in ass_styles],
        "profiles": [_serial(p) for p in db.query(Profile).all()],
        "role_catalog": [_serial(r) for r in db.query(RoleCatalog).all()],
    }


def estimate_and_create_backup(db: Session) -> dict:
    payload = _collect_personal_data(db)
    raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    compressed = lzma.compress(raw, preset=9 | lzma.PRESET_EXTREME)

    backup_dir = get_backup_dir(db)
    try:
        free = shutil.disk_usage(backup_dir if os.path.isdir(backup_dir) else os.path.dirname(backup_dir) or backup_dir).free
    except OSError:
        # Target drive/dir doesn't exist yet at all — treat as "can't check,
        # assume it fits" rather than blocking the update over a missing
        # folder that os.makedirs below would create anyway.
        free = None

    if free is not None and len(compressed) > free:
        return {"ok": False, "needed_bytes": len(compressed), "free_bytes": free}

    os.makedirs(backup_dir, exist_ok=True)
    dest = os.path.join(backup_dir, BACKUP_FILENAME)
    with open(dest, "wb") as f:
        f.write(compressed)
    return {"ok": True, "size_bytes": len(compressed), "path": dest}


def get_last_restore_result() -> "dict | None":
    return _last_restore_result


def restore_and_cleanup_backup(db: Session) -> "dict | None":
    """No-ops (returns None) on the overwhelmingly common case — no
    backup file present, i.e. every normal startup that isn't right after
    an update. Additive only: a title is restored only if no local title
    with that exact name already exists, never overwriting current data
    (same conflict posture as sync_service.pull_and_merge elsewhere)."""
    global _last_restore_result
    backup_dir = get_backup_dir(db)
    path = os.path.join(backup_dir, BACKUP_FILENAME)
    if not os.path.isfile(path):
        return None

    try:
        with open(path, "rb") as f:
            payload = json.loads(lzma.decompress(f.read()).decode("utf-8"))
    except (OSError, lzma.LZMAError, ValueError):
        # Corrupt/unreadable backup — don't loop trying to restore it
        # forever, just clear it and move on.
        try:
            os.remove(path)
        except OSError:
            pass
        _last_restore_result = {"titles_restored": 0, "error": "backup file unreadable, discarded"}
        return _last_restore_result

    try:
        restored = _restore_payload(db, payload)
    except Exception as e:
        # A backup that decompressed fine but doesn't reconstruct cleanly
        # (unexpected/missing fields from a future or foreign format) must
        # not be retried forever — restore_and_cleanup_backup runs on EVERY
        # startup via init_db(), so leaving the file in place here would
        # crash the backend on every single launch instead of just this one.
        db.rollback()
        try:
            os.remove(path)
        except OSError:
            pass
        _last_restore_result = {"titles_restored": 0, "error": f"restore failed, backup discarded: {e}"}
        return _last_restore_result

    try:
        os.remove(path)
    except OSError:
        pass
    _last_restore_result = {"titles_restored": restored}
    return _last_restore_result


def _restore_payload(db: Session, payload: dict) -> int:
    existing_names = {t.name_ua for t in db.query(Title).all()}
    old_to_new_title_id: dict[int, int] = {}
    old_to_new_char_id: dict[int, int] = {}
    restored = 0

    for t in payload.get("titles", []):
        if t["name_ua"] in existing_names:
            continue
        new_title = Title(
            name_ua=t["name_ua"], name_original=t.get("name_original", ""),
            poster_path=t.get("poster_path"), status=t.get("status", "new"), show_key=t.get("show_key"),
        )
        db.add(new_title)
        db.flush()
        old_to_new_title_id[t["id"]] = new_title.id
        restored += 1

    for c in payload.get("characters", []):
        if c["title_id"] not in old_to_new_title_id:
            continue
        new_char = Character(
            title_id=old_to_new_title_id[c["title_id"]], name=c["name"], code=c.get("code"),
            team_device_id=c.get("team_device_id"),
        )
        db.add(new_char)
        db.flush()
        old_to_new_char_id[c["id"]] = new_char.id

    old_to_new_episode_id: dict[int, int] = {}
    for e in payload.get("episodes", []):
        if e["title_id"] not in old_to_new_title_id:
            continue
        new_ep = Episode(
            title_id=old_to_new_title_id[e["title_id"]], season=e.get("season", 1), number=e["number"],
            duration=e.get("duration"), original_file_path=e.get("original_file_path"),
            original_size=e.get("original_size"), original_bitrate=e.get("original_bitrate"),
            original_format=e.get("original_format"), status=e.get("status", "not_uploaded"),
            subtitle_stage=e.get("subtitle_stage", "translating"),
        )
        db.add(new_ep)
        db.flush()
        old_to_new_episode_id[e["id"]] = new_ep.id

    for l in payload.get("subtitle_lines", []):
        if l["episode_id"] not in old_to_new_episode_id:
            continue
        db.add(SubtitleLine(
            episode_id=old_to_new_episode_id[l["episode_id"]], start_ms=l["start_ms"], end_ms=l["end_ms"],
            text=l.get("text", ""), character_id=old_to_new_char_id.get(l.get("character_id")),
            ass_style=l.get("ass_style", "Default"), is_overlap=bool(l.get("is_overlap")),
            layer=l.get("layer", 0), margin_l=l.get("margin_l", 0), margin_r=l.get("margin_r", 0),
            margin_v=l.get("margin_v", 0),
        ))

    for m in payload.get("markers", []):
        if m["episode_id"] not in old_to_new_episode_id:
            continue
        db.add(Marker(
            episode_id=old_to_new_episode_id[m["episode_id"]], reaper_name=m["reaper_name"],
            position_seconds=m["position_seconds"], confirmed=bool(m.get("confirmed")),
            color=m.get("color"), character_id=old_to_new_char_id.get(m.get("character_id")),
        ))

    for a in payload.get("ass_style_defs", []):
        if a["episode_id"] not in old_to_new_episode_id:
            continue
        db.add(AssStyleDef(
            episode_id=old_to_new_episode_id[a["episode_id"]], name=a["name"], raw_fields=a["raw_fields"],
        ))

    existing_role_keys = {r.key for r in db.query(RoleCatalog).all()}
    for r in payload.get("role_catalog", []):
        if r["key"] in existing_role_keys:
            continue
        db.add(RoleCatalog(key=r["key"], label=r["label"], sort_order=r.get("sort_order", 0)))
        existing_role_keys.add(r["key"])

    existing_profile_names = {p.name for p in db.query(Profile).all()}
    existing_telegram_ids = {p.telegram_id for p in db.query(Profile).all() if p.telegram_id is not None}
    for p in payload.get("profiles", []):
        if p["name"] in existing_profile_names:
            continue
        if p.get("telegram_id") is not None and p["telegram_id"] in existing_telegram_ids:
            continue
        db.add(Profile(
            name=p["name"], role=p.get("role", "Звукорежисер"), roles=p.get("roles"),
            color=p.get("color", "#E52128"), is_admin=bool(p.get("is_admin")),
            password_hash=p.get("password_hash"), telegram_id=p.get("telegram_id"),
            telegram_username=p.get("telegram_username"), avatar_url=p.get("avatar_url"),
        ))
        existing_profile_names.add(p["name"])
        if p.get("telegram_id") is not None:
            existing_telegram_ids.add(p["telegram_id"])

    db.commit()
    return restored
