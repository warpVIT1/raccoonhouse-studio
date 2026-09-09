"""
"Відкрити в Reaper" — one button for an actor: downloads the 480p hardsub
video (same file already offered via ActorWorkspace.tsx's own "Завантажити"
button, see actor_video_service.py) if not already local, generates a
ready-to-open .rpp Reaper project next to it — Track 1 plays that video at
30% volume as a timing/performance reference, Track 2 is empty and armed
for the actor's own recording, and every one of the actor's own subtitle
lines becomes a project marker (line text as the marker name) so they can
see exactly when and what to say scrubbing through the timeline.

This hand-writes the .rpp text format directly rather than going through
the existing ReaScript-Lua export (reaper_exporter.export_reascript_lua) —
that path requires the actor to already have Reaper open and manually run
the script via the Actions list; this one is meant to be double-clicked
(or handed to the OS via openPath) and have Reaper open the whole session
immediately. First real-world test of this exact format is pending — if
Reaper reports a parse error or drops something, this is the file to fix.
"""
import os
import re
import uuid
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import Character, Episode, SubtitleLine, Title
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from . import discovery_service

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def _rpp_guid() -> str:
    return "{" + str(uuid.uuid4()).upper() + "}"


def _rpp_escape(text: str) -> str:
    return text.replace('"', "'").replace("\n", " / ").replace("\r", "")


def _build_rpp(video_filename: str, video_duration: float, character_name: str, lines: list[SubtitleLine]) -> str:
    lines_out: list[str] = []
    lines_out.append(f'<REAPER_PROJECT 0.1 "6.0" 0')
    lines_out.append("  SAMPLERATE 48000 0 0")
    lines_out.append(f'  <TRACK {_rpp_guid()}')
    lines_out.append('    NAME "ОРИГІНАЛ (ХАРДСАБ, тихо)"')
    # VOLPAN: volume(linear) pan width followpan pan2 — 0.3 ≈ -10.5dB,
    # audible for timing without drowning out the actor's own take.
    lines_out.append("    VOLPAN 0.3 0 -1 -1 1")
    lines_out.append("    REC 0 0 0 0 0 0 0")
    lines_out.append("    <ITEM")
    lines_out.append("      POSITION 0")
    lines_out.append(f"      LENGTH {max(video_duration, 1.0):.3f}")
    lines_out.append(f'      NAME "{_rpp_escape(video_filename)}"')
    lines_out.append(f"      GUID {_rpp_guid()}")
    lines_out.append("      <SOURCE VIDEO")
    lines_out.append(f'        FILE "{video_filename}"')
    lines_out.append("      >")
    lines_out.append("    >")
    lines_out.append("  >")
    lines_out.append(f'  <TRACK {_rpp_guid()}')
    lines_out.append(f'    NAME "{_rpp_escape(character_name)}"')
    lines_out.append("    VOLPAN 1 0 -1 -1 1")
    # REC: recarm=1, input=0 (mic input 1, mono), recmon=1 (monitor on so
    # the actor hears themselves while recording).
    lines_out.append("    REC 1 0 1 0 0 0 0")
    lines_out.append("  >")
    # Regions, not plain point markers — a subtitle line has a real
    # start AND end, and the actor needs to see that whole span on the
    # timeline (how long they actually have to say it), not just a single
    # tick where it starts (confirmed live 2026-09-09, first version used
    # plain MARKER lines — visually wrong for something with a duration).
    # RPP's own MARKER line doubles as a region when the 4th field (after
    # the name) carries the region's END position instead of 0 — the
    # trailing "R" makes the region-vs-marker distinction explicit rather
    # than relying purely on that field being non-zero.
    for i, line in enumerate(lines, start=1):
        start = line.start_ms / 1000.0
        end = line.end_ms / 1000.0
        name = _rpp_escape(line.text.strip()) or "…"
        lines_out.append(f'  MARKER {i} {start:.3f} "{name}" {end:.3f} 0 1 R {_rpp_guid()}')
    lines_out.append(">")
    return "\n".join(lines_out) + "\n"


def run_generate_actor_reaper_project(
    episode_id: int, character_id: int, reporter: ProgressReporter,
) -> dict:
    db = SessionLocal()
    try:
        return _run_generate_actor_reaper_project(episode_id, character_id, reporter, db)
    finally:
        db.close()


def _run_generate_actor_reaper_project(
    episode_id: int, character_id: int, reporter: ProgressReporter, db: Session,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")
    char = db.get(Character, character_id)
    if not char:
        raise ValueError(f"Character {character_id} not found")
    if not ep.actor_video_transfer_id:
        raise ValueError("Відео для акторів ще не готове — режисер має спершу натиснути «Надіслати акторам»")

    title = db.get(Title, ep.title_id)
    safe_char_name = re.sub(r"[^\w\-]+", "_", char.name, flags=re.UNICODE)
    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id) / "reaper" / safe_char_name
    ep_dir.mkdir(parents=True, exist_ok=True)
    video_filename = "original_hardsub.mp4"
    video_path = ep_dir / video_filename

    if not video_path.is_file():
        reporter.update(2, "Завантажую відео-орієнтир…")
        discovery_service.download_transfer(
            ep.actor_video_transfer_id, str(video_path),
            on_progress=lambda pct: reporter.update(2 + int(pct * 0.85), "Завантажую відео-орієнтир…"),
        )
    else:
        reporter.update(87, "Відео-орієнтир вже завантажено…")

    reporter.update(90, "Готую маркери реплік…")
    everyone_char_ids = [
        c.id for c in db.query(Character)
        .filter(Character.title_id == ep.title_id, Character.team_device_id == "everyone")
        .all()
        if c.id != character_id
    ]
    char_ids = [character_id, *everyone_char_ids]
    lines = (
        db.query(SubtitleLine)
        .filter(SubtitleLine.episode_id == episode_id, SubtitleLine.character_id.in_(char_ids))
        .order_by(SubtitleLine.start_ms)
        .all()
    )

    reporter.update(95, "Генерую проєкт Reaper…")
    # Episode.duration (matches the ORIGINAL video) isn't reliable here —
    # confirmed live 2026-09-09: it was unset for an episode pulled in via
    # sync, so the old `ep.duration or 0.0` fallback silently produced a
    # 1-SECOND item length (max(0.0, 1.0)), truncating the reference track
    # to almost nothing even though the actual video was a full episode.
    # Probing the file we JUST downloaded directly sidesteps any mismatch
    # between the original's duration and this 480p proxy's own (they're
    # re-encoded separately and could differ slightly anyway).
    from .ffmpeg_service import _probe
    probe = _probe(str(video_path))
    video_duration = float(probe.get("format", {}).get("duration", 0)) or (ep.duration or 0.0)
    rpp_text = _build_rpp(video_filename, video_duration, char.name, lines)

    # "{title name in English/original}_{season}_{episode}_{team}" — per
    # the user's own naming spec (2026-09-09), not the show_key convention
    # export_srt_for_character/reaper_exporter use elsewhere.
    title_name_en = (title.name_original if title and title.name_original else (title.name_ua if title else "Title"))
    team_name = "local"
    if title and title.team_id:
        from ..services import team_service
        try:
            team = team_service.get_team(title.team_id)
            team_name = team["name"] if team else title.team_id
        except Exception:
            team_name = title.team_id
    safe_title = re.sub(r"[^\w\-]+", "_", title_name_en, flags=re.UNICODE).strip("_") or "Title"
    safe_team = re.sub(r"[^\w\-]+", "_", team_name, flags=re.UNICODE).strip("_") or "local"
    rpp_filename = f"{safe_title}_{ep.season}_{ep.number}_{safe_team}.rpp"
    rpp_path = ep_dir / rpp_filename
    rpp_path.write_text(rpp_text, encoding="utf-8")

    reporter.update(100, "Готово")
    return {"rpp_path": str(rpp_path), "video_path": str(video_path)}
