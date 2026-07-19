"""
Reaper export services:
  1. Marker CSV — matches Reaper's native marker CSV format exactly
  2. ReaScript Lua — compatible with studio's sort_dub_tracks / distribute_dub_files / render_dub_tracks scripts
"""
import os
from sqlalchemy.orm import Session

from ..models import Marker, Episode, Character, CharacterDubberMap, Dubber, Title


def _seconds_to_time(s: float) -> str:
    """float seconds → HH:MM:SS.mmm"""
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}"


def export_marker_csv(
    episode_id: int,
    db: Session,
    position_format: str = "time",
    bpm: float = 120.0,
) -> str:
    """
    Generate Reaper-compatible marker CSV.

    Format: #,Name,Start,End,Length
    Point markers: Start filled, End/Length blank.
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

    lines = ["#,Name,Start,End,Length"]
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

        lines.append(f"M{i},{m.reaper_name},{pos},,")

    return "\n".join(lines) + "\n"


def export_reascript_lua(episode_id: int, db: Session) -> str:
    """
    Generate Lua ReaScript that:
    - Creates a Reaper project with tracks per dubber
    - Inserts markers from the markers table
    - Compatible with studio's distribute_dub_files.lua & dubbers_db.json convention
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
