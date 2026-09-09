"""
Reaper export services:
  1. Marker CSV — matches Reaper's native marker CSV format exactly
  2. ReaScript Lua — compatible with studio's sort_dub_tracks / distribute_dub_files / render_dub_tracks scripts
"""
import os
from typing import Optional
from sqlalchemy.orm import Session

from ..models import Marker, Episode, Character, CharacterDubberMap, Dubber, Title


def _seconds_to_time(s: float) -> str:
    """float seconds → HH:MM:SS.mmm"""
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}"


def _marker_codes(reaper_name: str) -> list[str]:
    """A marker's name is "<code>[,<code>...] - <label>" (see
    MarkersTab.tsx's appendCode/CharacterPicker — one marker can belong to
    several characters at once for a group scene). Splits out just the
    code list, tolerating names that were hand-edited in Reaper itself and
    don't perfectly follow that convention (falls back to no codes rather
    than raising)."""
    if " - " not in reaper_name:
        return []
    prefix = reaper_name.split(" - ", 1)[0]
    return [c.strip() for c in prefix.split(",") if c.strip()]


_GROUP_MARKER_KEYWORDS = ("ГУРТІВКА", "УСІ ГОЛОВНІ", "ВСІ ГОЛОВНІ")


def _is_group_marker(reaper_name: str) -> bool:
    """Group-recording markers bracket a segment where several actors are
    in the booth together — they're not any one person's marker, so every
    per-actor export includes them regardless of character filtering.
    Matches both this app's own "+ Гуртівка ▶/◀" quick-add buttons AND the
    "Усі головні - Початок/Кінець" naming seen in a real studio's own
    Reaper session (confirmed live 2026-08-18) — different sessions use
    different wording for the same concept, so this checks a small known
    set of synonyms rather than one fixed string."""
    upper = reaper_name.upper()
    return any(kw in upper for kw in _GROUP_MARKER_KEYWORDS)


def _everyone_character_ids(db: Session, title_id: int) -> set[int]:
    """Character ids tied to the "Усі" pseudo-actor (Character.team_device_id
    == "everyone", see routers/teams.py's get_team_actors) — a marker
    assigned to one of these belongs in EVERY actor's own export, same idea
    as a "гуртівка"/group marker but driven by an explicit assignment rather
    than name-matching."""
    return {
        c.id for c in db.query(Character)
        .filter(Character.title_id == title_id, Character.team_device_id == "everyone")
        .all()
    }


def _filter_markers_for_actor(
    markers: list["Marker"], character_code: Optional[str], character_id: Optional[int],
    everyone_char_ids: "set[int] | None" = None,
) -> list["Marker"]:
    """Shared by export_marker_csv/export_reascript_lua: keeps a marker if
    it matches the requested actor by EITHER the legacy reaper_name-prefix
    code (character_code — old ASS-derived Characters, see _marker_codes)
    OR the modern Marker.character_id link (see routers/markers.py's PUT
    .../markers/by-color, set via the subtitle grid's team-actor dropdown),
    since a title can have a mix of both depending on when its characters
    were created. No filtering at all if neither is given. Гуртівка markers
    and markers tied to the "Усі" pseudo-actor (everyone_char_ids) always
    pass through untouched either way."""
    if not character_code and not character_id:
        return markers
    everyone_char_ids = everyone_char_ids or set()
    result = []
    for m in markers:
        if _is_group_marker(m.reaper_name):
            result.append(m)
            continue
        if m.character_id in everyone_char_ids:
            result.append(m)
            continue
        if character_code and character_code in _marker_codes(m.reaper_name):
            result.append(m)
            continue
        if character_id and m.character_id == character_id:
            result.append(m)
    return result


def export_marker_csv(
    episode_id: int,
    db: Session,
    position_format: str = "time",
    bpm: float = 120.0,
    character_code: Optional[str] = None,
    character_id: Optional[int] = None,
) -> str:
    """
    Generate Reaper-compatible marker CSV.

    Format: #,Name,Start,End,Length
    Point markers: Start filled, End/Length blank.

    character_code/character_id, when given, keep only markers belonging to
    that actor — the "actor" role workspace's "download just my markers"
    button — see _filter_markers_for_actor for exactly how each one
    matches (and why гуртівка markers are always kept regardless).
    """
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    markers = (
        db.query(Marker)
        .filter(Marker.episode_id == episode_id)
        .order_by(Marker.position_seconds)
        .all()
    )
    markers = _filter_markers_for_actor(
        markers, character_code, character_id, _everyone_character_ids(db, ep.title_id),
    )

    # Color is a trailing, optional column — this app's own extension for
    # round-tripping through markers/import (see routers/markers.py), not
    # part of Reaper's own native marker CSV format.
    lines = ["#,Name,Start,End,Length,Color"]
    for i, m in enumerate(markers, 1):
        if position_format == "time":
            pos = _seconds_to_time(m.position_seconds)
        else:
            # Bars.Beats.Ticks (assuming 4/4, ppq=960)
            beat = m.position_seconds * bpm / 60.0
            bar = int(beat // 4) + 1
            beat_in_bar = int(beat % 4) + 1
            ticks = int((beat % 1) * 960)
            pos = f"{bar}.{beat_in_bar}.{ticks:03d}"

        lines.append(f"M{i},{m.reaper_name},{pos},,,{m.color or ''}")

    return "\n".join(lines) + "\n"


def export_reascript_lua(episode_id: int, db: Session, character_code: Optional[str] = None, character_id: Optional[int] = None) -> str:
    """
    Generate Lua ReaScript that:
    - Creates a Reaper project with tracks per dubber
    - Inserts markers from the markers table
    - Compatible with studio's distribute_dub_files.lua & dubbers_db.json convention

    character_code/character_id, when given, keep only markers belonging to
    that actor, same filter as export_marker_csv above (see
    _filter_markers_for_actor) — the DUBBERS track list itself is left
    showing everyone, since it's just project setup, not something that
    needs to shrink for one actor.
    """
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    title = db.get(Title, ep.title_id)
    title_name = title.name_ua if title else "Unknown"
    show_key = (title.show_key or title_name.replace(" ", "_"))[:16] if title else "Show"

    markers = (
        db.query(Marker)
        .filter(Marker.episode_id == episode_id)
        .order_by(Marker.position_seconds)
        .all()
    )
    markers = _filter_markers_for_actor(
        markers, character_code, character_id, _everyone_character_ids(db, ep.title_id),
    )

    # Build dubber list for this title
    chars = db.query(Character).filter(Character.title_id == ep.title_id).all()
    dubbers: dict[str, str] = {}  # dubber_name → character_code
    for char in chars:
        mapping = (
            db.query(CharacterDubberMap)
            .filter(CharacterDubberMap.character_id == char.id)
            .first()
        )
        if mapping:
            dub = db.get(Dubber, mapping.dubber_id)
            if dub:
                dubbers[dub.name] = char.code or char.name[:2].upper()

    # Build Lua
    lua_lines = [
        "-- RaccoonHouse Studio generated ReaScript",
        f"-- Title: {title_name}  |  Season {ep.season}  Episode {ep.number}",
        "-- Compatible with: sort_dub_tracks.lua / distribute_dub_files.lua / render_dub_tracks.lua",
        "",
        "local r = reaper",
        "",
        f'local SHOW_KEY = "{show_key}"',
        f"local SEASON = {ep.season}",
        f"local EPISODE = {ep.number}",
        "",
        "-- Dubbers database (matches dubbers_db.json convention)",
        "local DUBBERS = {",
    ]

    for dub_name, char_code in dubbers.items():
        safe_name = dub_name.replace('"', '\\"')
        lua_lines.append(f'  {{ name = "{safe_name}", code = "{char_code}" }},')

    lua_lines += [
        "}",
        "",
        "-- Create tracks for each dubber",
        "r.Main_OnCommand(40297, 0)  -- unselect all tracks",
        "for i, dub in ipairs(DUBBERS) do",
        "  r.InsertTrackAtIndex(i - 1, true)",
        "  local tr = r.GetTrack(0, i - 1)",
        '  r.GetSetMediaTrackInfo_String(tr, "P_NAME", dub.name .. " (" .. dub.code .. ")", true)',
        "end",
        "",
        "-- Insert markers",
    ]

    for m in markers:
        safe_name = m.reaper_name.replace('"', '\\"')
        lua_lines.append(
            f'r.AddProjectMarker2(0, false, {m.position_seconds:.3f}, 0, "{safe_name}", -1, 0)'
        )

    lua_lines += [
        "",
        'r.ShowMessageBox("Треки та маркери налаштовано!\\n'
        'Тепер запустіть distribute_dub_files.lua", "RaccoonHouse Studio", 0)',
    ]

    return "\n".join(lua_lines) + "\n"


def export_dubbers_json(title_id: int, db: Session) -> str:
    """Export dubbers_db.json compatible format."""
    import json
    chars = db.query(Character).filter(Character.title_id == title_id).all()
    entries = []
    for char in chars:
        mapping = (
            db.query(CharacterDubberMap)
            .filter(CharacterDubberMap.character_id == char.id, CharacterDubberMap.title_id == title_id)
            .first()
        )
        if mapping:
            dub = db.get(Dubber, mapping.dubber_id)
            entries.append({
                "character": char.name,
                "code": char.code or char.name[:2].upper(),
                "dubber": dub.name if dub else "",
            })
    return json.dumps(entries, ensure_ascii=False, indent=2)
