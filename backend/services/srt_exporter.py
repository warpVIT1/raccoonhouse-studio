"""
Per-actor SRT export, plus one combined full ASS alongside it.

Output per episode:
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>-<CharName>.srt
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>--Перебивка.srt
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>--Текст.srt
  RaccoonHouse_<ShowKey>.S0<season>E0<episode>-ПОВНИЙ.ass

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


def _ms_to_ass(ms: int) -> str:
    """milliseconds → ASS timecode H:MM:SS.cc (centiseconds, no leading zero on hours)"""
    h = ms // 3_600_000
    m = (ms % 3_600_000) // 60_000
    s = (ms % 60_000) // 1000
    cs = (ms % 1000) // 10
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


# ASS's own [V4+ Styles] block (fonts, colors, positions) is read at import
# time (see subtitle_parser.parse_ass_file) but never persisted — only the
# per-line style *name* is kept on SubtitleLine.ass_style, since nothing
# downstream of import needs the actual look. Re-exporting a full ASS
# therefore can't reproduce the original styling exactly; this generates one
# generic bottom-centered style per distinct style name actually used by the
# episode's lines, which is enough for the file to load and play correctly
# in Aegisub/a player — anyone who needs the original fansub's exact look
# back should still keep that original .ass around.
_DEFAULT_ASS_STYLE = (
    "Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,"
    "0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1"
)


def _build_full_ass(lines: list[SubtitleLine], char_map: dict[int, str]) -> str:
    style_names = list(dict.fromkeys(line.ass_style or "Default" for line in lines)) or ["Default"]

    header = (
        "[Script Info]\n"
        "Title: RaccoonHouse Studio export\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "YCbCr Matrix: TV.709\n"
        "PlayResX: 1920\n"
        "PlayResY: 1080\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
    )
    for name in style_names:
        header += f"Style: {name},{_DEFAULT_ASS_STYLE}\n"

    header += (
        "\n[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    body = ""
    for line in lines:
        # User edits go through a plain textarea (real newlines), while text
        # straight from import still carries ASS's own literal "\N" escape —
        # normalize both to "\N" here so the exported file is valid either way.
        text = (line.text or "").replace("\r\n", "\n").replace("\n", "\\N")
        name = char_map.get(line.character_id, "") if line.character_id else ""
        style = line.ass_style or "Default"
        body += (
            f"Dialogue: 0,{_ms_to_ass(line.start_ms)},{_ms_to_ass(line.end_ms)},"
            f"{style},{name},0,0,0,,{text}\n"
        )

    return header + body


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

    # Generate per-actor SRTs plus one combined full ASS, all in one zip
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for bucket_name, bucket_lines in buckets.items():
            srt_content = ""
            for idx, line in enumerate(bucket_lines, 1):
                srt_content += _format_srt_block(idx, line.start_ms, line.end_ms, line.text)
            filename = f"{prefix}-{bucket_name}.srt"
            zf.writestr(filename, srt_content.encode("utf-8"))

        ass_content = _build_full_ass(lines, char_map)
        zf.writestr(f"{prefix}-ПОВНИЙ.ass", ass_content.encode("utf-8-sig"))

    return buf.getvalue()
