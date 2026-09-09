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

from ..models import Episode, SubtitleLine, SignStyle, AssStyleDef
from ..database import SessionLocal
from ..job_manager import ProgressReporter

# Canonical [V4+ Styles] field order (everything after "Style: <Name>,") —
# matches srt_exporter.py's own Format line exactly, so a style persisted
# here round-trips through _build_full_ass without re-normalizing again.
# Source files occasionally order columns differently (rare but valid ASS),
# so imported styles are re-mapped into this fixed order rather than stored
# verbatim in whatever order the source file happened to use.
ASS_STYLE_FIELDS = [
    "Fontname", "Fontsize", "PrimaryColour", "SecondaryColour", "OutlineColour", "BackColour",
    "Bold", "Italic", "Underline", "StrikeOut", "ScaleX", "ScaleY", "Spacing", "Angle",
    "BorderStyle", "Outline", "Shadow", "Alignment", "MarginL", "MarginR", "MarginV", "Encoding",
]
ASS_STYLE_DEFAULTS = dict(zip(
    ASS_STYLE_FIELDS,
    "Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1".split(","),
))


def _normalize_style_raw_fields(style: dict) -> str:
    return ",".join(style.get(f, ASS_STYLE_DEFAULTS[f]) for f in ASS_STYLE_FIELDS)


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


_SRT_BLOCK_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})"
)


def parse_srt_file(path: str) -> list[dict]:
    """Plain .srt has no styles/actor/margin info at all — just index,
    timecode, text blocks separated by a blank line. Normalizes each block
    into the SAME event dict shape parse_ass_file's [Events] parser
    produces (Start/End as ASS-format "H:MM:SS.cc" timecode strings, so
    _timecode_to_ms below handles either one identically; Style/Name/Layer/
    margins all default), so _run_ass_import's insert loop needs no
    SRT-specific branch at all — see run_import (the shared entry point for
    both formats)."""
    with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
        content = f.read()

    events: list[dict] = []
    # Blocks are separated by one or more blank lines; a block's first
    # non-blank line is the index (ignored, SRT indices aren't reliable
    # after hand-editing), second is the timecode range, the rest is text.
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = [ln for ln in block.splitlines() if ln.strip() != ""]
        if len(lines) < 2:
            continue
        time_line_idx = 1 if _SRT_BLOCK_RE.search(lines[0]) is None else 0
        m = _SRT_BLOCK_RE.search(lines[time_line_idx])
        if not m:
            continue
        sh, sm, ss, scs, eh, em, es, ecs = m.groups()
        start = f"{int(sh)}:{sm}:{ss}.{scs[:2]}"
        end = f"{int(eh)}:{em}:{es}.{ecs[:2]}"
        text = "\\N".join(lines[time_line_idx + 1:]).strip()
        if not text:
            continue
        events.append({
            "Start": start, "End": end, "Text": text,
            "Style": "Default", "Name": "", "Layer": "0",
            "MarginL": "0", "MarginR": "0", "MarginV": "0",
        })
    return events


def run_ass_import(
    episode_id: int,
    ass_path: str,
    reporter: ProgressReporter,
    preserve_assignments: bool = True,
) -> dict:
    """Opens its own DB session rather than reusing the request's — this runs
    in a background thread pool that outlives the HTTP request, and a
    request-scoped Session gets closed by FastAPI's dependency teardown right
    after the endpoint returns, well before this actually finishes."""
    db = SessionLocal()
    try:
        return _run_ass_import(episode_id, ass_path, reporter, db, preserve_assignments)
    finally:
        db.close()


def _run_ass_import(
    episode_id: int,
    ass_path: str,
    reporter: ProgressReporter,
    db: Session,
    preserve_assignments: bool = True,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    is_srt = ass_path.lower().endswith(".srt")
    reporter.update(5, "Читання файлу…")
    if is_srt:
        styles, events = [], parse_srt_file(ass_path)
    else:
        styles, events = parse_ass_file(ass_path)

    # Get sign styles for this title
    sign_style_names = {
        s.style_name for s in db.query(SignStyle).filter(SignStyle.title_id == ep.title_id).all()
    }

    # Carry actor assignments forward across a re-import — a translator
    # re-uploading a corrected file (typo fixes, retiming a couple of
    # lines) used to silently wipe every already-assigned actor, since the
    # whole episode's lines get deleted and recreated below with
    # character_id=None unconditionally. Primary match is exact (start_ms,
    # end_ms) — the common case of "text/timing mostly unchanged" — not a
    # content/text match, since translated text is exactly what's expected
    # to change between revisions.
    #
    # Confirmed live 2026-09-09 this exact-match-only approach kept
    # producing "it didn't offer/didn't keep the actors" reports even
    # after preserve_assignments defaulted to True everywhere — a re-export
    # round trip through an external tool (Aegisub, Reaper, whatever) can
    # shift every timestamp by a millisecond of rounding, which silently
    # fails EVERY exact match at once and looks indistinguishable from "did
    # nothing." Added a same-line-count positional fallback: when the new
    # file has exactly as many lines as the episode had before, any line
    # that didn't get an exact timing match falls back to whichever
    # character was on the line at the same position (sorted by start_ms)
    # in the old set. Less precise than exact timing, but per the user's
    # own call: better to carry everything over and let the director
    # correct individual lines by hand than to silently drop every
    # assignment on a harmless re-import.
    reporter.update(20, "Збереження призначених акторів…")
    old_assignments: dict[tuple[int, int], int] = {}
    old_char_by_position: list[int | None] = []
    if preserve_assignments:
        old_rows = (
            db.query(SubtitleLine.start_ms, SubtitleLine.end_ms, SubtitleLine.character_id)
            .filter(SubtitleLine.episode_id == episode_id)
            .order_by(SubtitleLine.start_ms)
            .all()
        )
        old_assignments = {(row[0], row[1]): row[2] for row in old_rows if row[2] is not None}
        old_char_by_position = [row[2] for row in old_rows]

    reporter.update(25, "Видалення старих субтитрів…")
    db.query(SubtitleLine).filter(SubtitleLine.episode_id == episode_id).delete()
    db.query(AssStyleDef).filter(AssStyleDef.episode_id == episode_id).delete()
    db.flush()

    # Persist the REAL style definitions (font/size/colours/position, not
    # just the name SubtitleLine.ass_style already kept) — needed for
    # accurate libass-based preview rendering (see VideoPlayer's JASSUB
    # integration) instead of srt_exporter.py's old one-generic-style-
    # for-everything fallback, which discarded this entirely before.
    for s in styles:
        name = s.get("Name", "").strip()
        if not name:
            continue
        db.add(AssStyleDef(episode_id=episode_id, name=name, raw_fields=_normalize_style_raw_fields(s)))
    db.flush()

    reporter.update(30, "Імпорт рядків…")

    total = len(events)
    inserted = 0
    # Positional rank of each event by its own Start time (not raw file
    # order — an ASS can list overlapping lines out of chronological order)
    # — only used as the fallback below when preserve_assignments is on and
    # the line count matches exactly, see that comment above.
    same_line_count = preserve_assignments and total == len(old_char_by_position)
    position_by_index: dict[int, int] = {}
    if same_line_count:
        order = sorted(range(total), key=lambda idx: _timecode_to_ms(events[idx].get("Start", "0:00:00.00")))
        position_by_index = {orig_idx: rank for rank, orig_idx in enumerate(order)}
    for i, ev in enumerate(events):
        if reporter.cancelled:
            raise RuntimeError("Скасовано")

        start_ms = _timecode_to_ms(ev.get("Start", "0:00:00.00"))
        end_ms = _timecode_to_ms(ev.get("End", "0:00:00.00"))
        text = ev.get("Text", "").strip()
        style = ev.get("Style", "Default").strip()
        actor_name = ev.get("Name", "").strip()

        def _int_field(key: str) -> int:
            try:
                return int(ev.get(key, "0").strip())
            except (ValueError, AttributeError):
                return 0

        layer = _int_field("Layer")
        margin_l = _int_field("MarginL")
        margin_r = _int_field("MarginR")
        margin_v = _int_field("MarginV")

        # Detect overlap
        is_overlap = bool(re.search(r"[/,]", actor_name))

        # No auto-match to a Character by the ASS Name field — imported
        # lines land actor-less unless a matching old line (see
        # old_assignments above) already had one; the translator/director
        # assigns a real team actor by hand via the АКТОР dropdown for
        # anything left unassigned.
        character_id = old_assignments.get((start_ms, end_ms))
        if character_id is None and same_line_count:
            character_id = old_char_by_position[position_by_index[i]]
        line = SubtitleLine(
            episode_id=episode_id,
            start_ms=start_ms,
            end_ms=end_ms,
            text=text,
            character_id=character_id,
            ass_style=style,
            is_overlap=is_overlap,
            layer=layer,
            margin_l=margin_l,
            margin_r=margin_r,
            margin_v=margin_v,
            source_actor_name=actor_name or None,
        )
        db.add(line)
        inserted += 1

        if i % 50 == 0:
            pct = int(30 + 60 * i / max(total, 1))
            reporter.update(pct, f"Імпорт рядків… {i}/{total}")

    # Адмін tab's translator status ("не взявся" -> "взявся") — the normal
    # translator workflow is importing a finished file, not hand-editing
    # lines one at a time, so gating this only on routers/subtitles.py's
    # update_subtitle_line (as it originally was) left every import-based
    # episode reading "не взявся" forever even with real content already in.
    # Same guard/field as that endpoint (see Episode.translation_started_at's
    # own comment) so both paths agree on what "started" means.
    just_started = ep.subtitle_stage == "translating" and not ep.translation_started_at
    if just_started:
        import datetime as dt
        ep.translation_started_at = dt.datetime.utcnow()

    db.commit()

    # ASS import bulk-inserts lines directly (unlike routers/subtitles.py's
    # own create endpoints, which already push individually) — without this,
    # an imported episode's lines silently never reach the cloud, and a
    # later pull (which treats an empty remote snapshot as authoritative)
    # can wipe the very lines just imported. See sync_service.py's
    # push_subtitle_lines.
    if ep.title.shared_id:
        from .sync_service import push_episode, push_subtitle_lines
        push_subtitle_lines(episode_id, db)
        if just_started:
            push_episode(episode_id, db)

    title = ep.title
    if title:
        from . import discovery_service
        from .sync_service import notify_role_for_title
        notify_role_for_title(
            title, "translator",
            f"Завантажено субтитри для {title.name_ua} — серія {ep.number}: {inserted} реплік.",
            discovery_service.notify_translator, db, episode=ep,
        )

    reporter.update(100, f"Імпортовано {inserted} рядків")
    return {"imported": inserted, "characters": 0}
