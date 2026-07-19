"""
Per-actor SRT export.

Output per episode:
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>-<CharName>.srt
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>--Перебивка.srt
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>--Текст.srt

All files zipped and returned as bytes.
"""
import io
import re
import zipfile
from collections import defaultdict
from sqlalchemy.orm import Session

from ..models import Episode, SubtitleLine, Character, CharacterDubberMap, Dubber, SignStyle, Title


def _ms_to_srt(ms: int) -> str:
    """milliseconds → SRT timecode HH:MM:SS,mmm"""
    h = ms // 3_600_000
    m = (ms % 3_600_000) // 60_000
    s = (ms % 60_000) // 1000
    mil = ms % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{mil:03d}"


def _strip_ass_tags(text: str) -> str:
    r"""Remove ASS override tags like {\i1}, {\an8} etc."""
    text = re.sub(r"\{[^}]*\}", "", text)
    text = text.replace("\\N", "\n").replace("\\n", "\n")
    return text.strip()


def _format_srt_block(idx: int, start_ms: int, end_ms: int, text: str) -> str:
    clean = _strip_ass_tags(text)
    return f"{idx}\n{_ms_to_srt(start_ms)} --> {_ms_to_srt(end_ms)}\n{clean}\n\n"


def export_per_actor_srt(episode_id: int, db: Session) -> bytes:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    title = db.get(Title, ep.title_id)
    show_key = (title.show_key or re.sub(r"\s+", "", title.name_ua))[:16] if title else "Show"
    season_str = f"S{ep.season:02d}"
    ep_str = f"E{ep.number:02d}"
    prefix = f"RaccoonHouse_{show_key}.{season_str}{ep_str}"

    # Get sign styles
    sign_style_names = {
        s.style_name for s in db.query(SignStyle).filter(SignStyle.title_id == ep.title_id).all()
    }

    # Get all subtitle lines, ordered
    lines = (
        db.query(SubtitleLine)
        .filter(SubtitleLine.episode_id == episode_id)
        .order_by(SubtitleLine.start_ms)
        .all()
    )

    # Build character → dubber name map
    char_map: dict[int, str] = {}
    for char in db.query(Character).filter(Character.title_id == ep.title_id).all():
        mapping = (
            db.query(CharacterDubberMap)
            .filter(CharacterDubberMap.character_id == char.id, CharacterDubberMap.title_id == ep.title_id)
            .first()
        )
        if mapping:
            dubber = db.get(Dubber, mapping.dubber_id)
            char_map[char.id] = dubber.name if dubber else char.name
        else:
            char_map[char.id] = char.name

    # Bucket lines (bucket key is the bare category name — the "-" before it in the
    # final filename comes from the format string below, so don't double it up here)
    buckets: dict[str, list[SubtitleLine]] = defaultdict(list)
    for line in lines:
        if line.ass_style in sign_style_names:
            buckets["Текст"].append(line)
        elif line.is_overlap:
            buckets["Перебивка"].append(line)
        elif line.character_id and line.character_id in char_map:
            buckets[char_map[line.character_id]].append(line)
        else:
            buckets["БезПерсонажа"].append(line)

    # Generate SRT files and zip
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for bucket_name, bucket_lines in buckets.items():
            srt_content = ""
            for idx, line in enumerate(bucket_lines, 1):
                srt_content += _format_srt_block(idx, line.start_ms, line.end_ms, line.text)
            filename = f"{prefix}-{bucket_name}.srt"
            zf.writestr(filename, srt_content.encode("utf-8"))

    return buf.getvalue()
