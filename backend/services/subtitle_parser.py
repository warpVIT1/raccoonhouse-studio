"""
ASS subtitle parser.

Reads [V4+ Styles] and [Events] sections from a .ass file.
Converts ASS timecodes (H:MM:SS.cc) to milliseconds.
Auto-creates characters for new Name values and prompts user to map to dubbers.
Flags is_overlap=True for Name values containing "/" or ",".
"""
import re
import os
from pathlib import Path
from typing import Optional
from sqlalchemy.orm import Session

from ..models import Episode, SubtitleLine, Character, SignStyle
from ..database import SessionLocal
from ..job_manager import ProgressReporter


def _timecode_to_ms(tc: str) -> int:
    """'0:01:23.45' → ms"""
    parts = tc.strip().split(":")
    if len(parts) != 3:
        return 0
    h = int(parts[0])
    m = int(parts[1])
    sc = parts[2].split(".")
    s = int(sc[0])
    cs = int(sc[1]) if len(sc) > 1 else 0
    return (h * 3600 + m * 60 + s) * 1000 + cs * 10


def parse_ass_file(path: str) -> tuple[list[dict], list[dict]]:
    """Returns (styles, events) where each event is a dialogue dict."""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        content = f.read()

    styles: list[dict] = []
    events: list[dict] = []

    # Parse [V4+ Styles] — Format line defines column order
    style_section = re.search(r"\[V4\+?\s*Styles\](.*?)(?:\[|\Z)", content, re.DOTALL)
    if style_section:
        lines = style_section.group(1).strip().splitlines()
        fmt: list[str] = []
        for line in lines:
            line = line.strip()
            if line.startswith("Format:"):
                fmt = [f.strip() for f in line[7:].split(",")]
            elif line.startswith("Style:"):
                vals = [v.strip() for v in line[6:].split(",", len(fmt)-1)]
                styles.append(dict(zip(fmt, vals)))

    # Parse [Events]
    events_section = re.search(r"\[Events\](.*?)(?:\[|\Z)", content, re.DOTALL)
    if events_section:
        lines = events_section.group(1).strip().splitlines()
        fmt = []
        for line in lines:
            line = line.strip()
            if line.startswith("Format:"):
                fmt = [f.strip() for f in line[7:].split(",")]
            elif line.startswith("Dialogue:"):
                # last field (Text) may contain commas
                n_fields = len(fmt)
                vals = line[9:].split(",", n_fields - 1)
                if len(vals) == n_fields:
                    ev = dict(zip(fmt, vals))
                    events.append(ev)

    return styles, events


def run_ass_import(
    episode_id: int,
    ass_path: str,
    reporter: ProgressReporter,
    db: Session,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    reporter.update(5, "Читання ASS файлу…")
    styles, events = parse_ass_file(ass_path)

    # Get sign styles for this title
    sign_style_names = {
        s.style_name for s in db.query(SignStyle).filter(SignStyle.title_id == ep.title_id).all()
    }

    reporter.update(15, "Аналіз персонажів…")

    # Collect unique Name values
    name_values = set()
    for ev in events:
        name = ev.get("Name", "").strip()
        if name:
            name_values.add(name)

    # Ensure characters exist
    existing_chars = {c.name: c for c in db.query(Character).filter(Character.title_id == ep.title_id).all()}
    for name in name_values:
        if name not in existing_chars:
            char = Character(title_id=ep.title_id, name=name)
            db.add(char)
            db.flush()
            existing_chars[name] = char

    db.flush()

    reporter.update(25, "Видалення старих субтитрів…")
    db.query(SubtitleLine).filter(SubtitleLine.episode_id == episode_id).delete()
    db.flush()

    reporter.update(30, "Імпорт рядків…")

    total = len(events)
    inserted = 0
    for i, ev in enumerate(events):
        if reporter.cancelled:
            raise RuntimeError("Скасовано")

        start_ms = _timecode_to_ms(ev.get("Start", "0:00:00.00"))
        end_ms = _timecode_to_ms(ev.get("End", "0:00:00.00"))
        text = ev.get("Text", "").strip()
        style = ev.get("Style", "Default").strip()
        actor_name = ev.get("Name", "").strip()

        # Detect overlap
        is_overlap = bool(re.search(r"[/,]", actor_name))

        # Resolve character
        char_id: Optional[int] = None
        if actor_name and not is_overlap:
            char = existing_chars.get(actor_name)
            if char:
                char_id = char.id

        line = SubtitleLine(
            episode_id=episode_id,
            start_ms=start_ms,
            end_ms=end_ms,
            text=text,
            character_id=char_id,
            ass_style=style,
            is_overlap=is_overlap,
        )
        db.add(line)
        inserted += 1

        if i % 50 == 0:
            pct = int(30 + 60 * i / max(total, 1))
            reporter.update(pct, f"Імпорт рядків… {i}/{total}")

    db.commit()
    reporter.update(100, f"Імпортовано {inserted} рядків")
    return {"imported": inserted, "characters": len(existing_chars)}
