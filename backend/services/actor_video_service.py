"""
Generates the 480p hardsub proxy handed to actors when a director clicks
"Надіслати акторам" (see routers/episodes.py's send_to_actors) — subtitles
burned directly into the video track (not a soft/toggleable stream), video
re-encoded down to a small, predictable size, uploaded to the same R2
transfer relay power-share already uses (cloudflare-signaling's
/transfer/:id routes — free tier, no egress fees). The object key is
prefixed "rh-team-" (shared with any future actor-upload-back feature, e.g.
recorded dub tracks) so ONE R2 lifecycle rule can auto-expire everything
under that prefix after 14 days without any application-side cleanup job
(see the one-time `wrangler r2 bucket lifecycle` setup, not application
code) — deliberately NOT a bucket-wide rule, since /feedback, /reports and
the shared Apex model catalog also live in this same bucket and must NOT
expire.
"""
import os
import re
import uuid
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import Character, Episode, SubtitleLine, Title
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from . import discovery_service, team_service
from .ffmpeg_service import _ffmpeg_bin, _probe, _parse_time, _spawn_cancel_watcher, DATA_DIR
from .power_share_service import app_logger, _ProgressFile
from .srt_exporter import build_current_ass

import subprocess


def _escape_ass_path_for_filter(path: str) -> str:
    # ffmpeg's filtergraph syntax treats ':' and '\' specially — a bare
    # Windows path (e.g. "C:\foo\bar.ass") breaks the subtitles= filter's own
    # option parsing at the drive-letter colon. Forward slashes sidestep the
    # backslash-escaping entirely; the drive-letter colon still needs an
    # explicit escape.
    return path.replace("\\", "/").replace(":", "\\:")


def _sanitize_filename_part(value: str) -> str:
    return re.sub(r"[^\w\-]+", "_", value, flags=re.UNICODE).strip("_") or "?"


def _build_video_filename(title: "Title | None", ep: Episode) -> str:
    """{команда}_{тайтл}_S{сезон}_E{серія}_{якість}_hardsub.mp4 — confirmed
    live 2026-08-18 as the exact naming the studio wants for the actor
    handoff video, both as the Telegram message's stated filename and the
    real Content-Disposition filename (see the Worker's GET /transfer/:id,
    which otherwise just serves a generic "episode.mp4"). Falls back to
    "Team"/title name when a team lookup fails — never blocks the handoff
    over a cosmetic filename."""
    team_name = "Team"
    if title and title.team_id:
        try:
            team = team_service.get_team(title.team_id)
            if team and team.get("name"):
                team_name = team["name"]
        except Exception:
            pass
    title_part = (title.show_key or title.name_ua) if title else "episode"
    return (
        f"{_sanitize_filename_part(team_name)}_{_sanitize_filename_part(title_part)}"
        f"_S{ep.season:02d}_E{ep.number:02d}_480p_hardsub.mp4"
    )


def run_export_actor_video(episode_id: int, reporter: ProgressReporter, only_character_id: int | None = None) -> dict:
    db = SessionLocal()
    try:
        return _run_export_actor_video(episode_id, reporter, db, only_character_id)
    finally:
        db.close()


def _run_export_actor_video(
    episode_id: int, reporter: ProgressReporter, db: Session, only_character_id: int | None = None,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")
    title = db.get(Title, ep.title_id)

    out_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "actor_video_480p.mp4"

    # "Тільки цьому актору" on a character added after the shared video was
    # already generated for everyone else — reuse that exact video/transfer
    # instead of re-encoding a multi-minute file just to notify one more
    # person. Only takes this shortcut when the previously-rendered file is
    # still actually on disk; anything else (first send ever, or the local
    # file got cleaned up) falls through to a full regenerate below.
    if only_character_id is not None and ep.actor_video_transfer_id and out_path.is_file():
        transfer_id = ep.actor_video_transfer_id
        size = out_path.stat().st_size
        reporter.update(99, "Сповіщаю актора…")
        ep_label = f"{title.name_ua if title else '?'} — серія {ep.number}"
        video_filename = _build_video_filename(title, ep)
        per_actor_notified = _send_per_actor_srts(episode_id, ep, title, db, video_filename, size, only_character_id)
        reporter.update(100, "Готово")
        return {"transfer_id": transfer_id, "notified": 0, "per_actor_notified": per_actor_notified}

    if not ep.original_file_path or not os.path.isfile(ep.original_file_path):
        raise ValueError("Оригінальне відео не знайдено")

    reporter.update(2, "Готую субтитри…")
    ass_content = build_current_ass(episode_id, db)
    ass_path = out_dir / "actor_video_hardsub.ass"
    ass_path.write_text(ass_content, encoding="utf-8")

    escaped_ass = _escape_ass_path_for_filter(str(ass_path))

    reporter.update(5, "ffmpeg: аналіз відео…")
    probe = _probe(ep.original_file_path)
    duration = float(probe.get("format", {}).get("duration", 0)) or (ep.duration or 0)

    cmd = [
        _ffmpeg_bin(), "-y",
        "-i", ep.original_file_path,
        "-vf", f"scale=-2:480,subtitles='{escaped_ass}'",
        "-c:v", "libx264", "-preset", "fast", "-crf", "28",
        "-maxrate", "1000k", "-bufsize", "2000k",
        "-c:a", "aac", "-b:a", "128k",
        str(out_path),
    ]
    app_logger.info("run_export_actor_video: episode=%s running ffmpeg: %s", episode_id, " ".join(cmd))
    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    watcher = _spawn_cancel_watcher(proc, lambda: reporter.cancelled)
    try:
        stderr_tail: list[str] = []
        for line in proc.stderr:
            stderr_tail.append(line)
            if len(stderr_tail) > 200:
                stderr_tail.pop(0)
            if reporter.cancelled:
                proc.kill()
                raise RuntimeError("Скасовано")
            if "time=" in line and duration:
                t = _parse_time(line)
                pct = min(75, int(5 + 70 * t / duration))
                reporter.update(pct, "ffmpeg: вшиваю субтитри та стискаю відео…")
        proc.wait()
    finally:
        if watcher:
            watcher.set()
    if reporter.cancelled:
        raise RuntimeError("Скасовано")
    if proc.returncode != 0:
        app_logger.error(
            "run_export_actor_video: episode=%s ffmpeg exited with code %s, last output:\n%s",
            episode_id, proc.returncode, "".join(stderr_tail),
        )
        raise RuntimeError("Не вдалося створити відео для акторів (ffmpeg)")

    old_transfer_id = ep.actor_video_transfer_id
    transfer_id = f"rh-team-actorvideo-{episode_id}-{uuid.uuid4().hex}"
    size = out_path.stat().st_size

    reporter.update(78, "Завантажую на сервер…")
    progress_file = _ProgressFile(
        str(out_path), size,
        on_progress=lambda pct: reporter.update(pct, "Завантажую на сервер…"),
        pct_lo=78, pct_hi=98,
    )
    try:
        discovery_service.upload_transfer(transfer_id, progress_file, size)
    finally:
        progress_file.close()

    if old_transfer_id:
        discovery_service.delete_transfer(old_transfer_id)

    ep.actor_video_transfer_id = transfer_id
    db.commit()

    # Without this, actor_video_transfer_id stays a purely local field —
    # every teammate's own ActorWorkspace resolves the download URl from
    # THEIR OWN local Episode row (see routers/episodes.py's
    # get_actor_video_url), which pull_and_merge never populates unless
    # this is pushed (confirmed live 2026-08-19: the "Завантажити" card
    # never appeared for anyone but the device that generated the video).
    if ep.shared_id:
        from ..services import sync_service
        sync_service.push_actor_video_transfer_id(episode_id, db)

    reporter.update(99, "Сповіщаю акторів…")
    ep_label = f"{title.name_ua if title else '?'} — серія {ep.number}"
    video_filename = _build_video_filename(title, ep)
    # Telegram is notification-only here — no links, no buttons (see
    # notify_device's own comment). Actors pull the actual files from
    # inside the app itself (ActorWorkspace's own download buttons).
    message = f"Готово до озвучення: {ep_label}. Відео з субтитрами (480p) вже доступне в програмі."
    notified = discovery_service.notify_actors(message, team_id=title.team_id if title else None)

    per_actor_notified = _send_per_actor_srts(episode_id, ep, title, db, video_filename, size)

    app_logger.info(
        "run_export_actor_video: episode=%s done transfer_id=%s size=%s notified=%s per_actor_notified=%s",
        episode_id, transfer_id, size, notified, per_actor_notified,
    )
    return {"transfer_id": transfer_id, "notified": notified, "per_actor_notified": per_actor_notified}


def _format_size(num_bytes: int) -> str:
    mb = num_bytes / (1024 * 1024)
    if mb >= 1:
        return f"{mb:.1f} МБ"
    return f"{num_bytes / 1024:.0f} КБ"


def _send_per_actor_srts(
    episode_id: int, ep: Episode, title: "Title | None", db: Session, video_filename: str, video_size: int,
    only_character_id: int | None = None,
) -> int:
    """One plain-text Telegram notification per assigned actor — episode
    assignment plus how many of the episode's lines are theirs (count +
    share of the total, confirmed live 2026-08-18 against a reference
    screenshot of this exact "Name: count (pct%)" format from another
    tool) and the video's filename/size. Deliberately no links or buttons
    (Telegram here is notification-only, by explicit request) — the actual
    files are pulled from inside the app itself (ActorWorkspace's own
    download buttons, which hit the local backend directly rather than any
    R2 transfer). Only characters tied to a real team actor (see
    Character.team_device_id, set via the АКТОР dropdown) have anyone to
    notify — old-style/ASS-derived characters with no team_device_id are
    skipped since there's no one specific to tell. Best-effort per actor:
    one failed notify shouldn't block the rest.
    `only_character_id` — DirectorWorkspace's per-row "Тільки цьому актору"
    button (routers/episodes.py's send-to-actor) — restricts this to a
    single character instead of the usual bulk-send-to-everyone.
    Audio bundling is deliberately not part of this — actors don't record
    anything yet at this stage, that piece is paused for now."""
    total_lines = db.query(SubtitleLine).filter(SubtitleLine.episode_id == episode_id).count()
    chars_query = (
        db.query(Character)
        .join(SubtitleLine, SubtitleLine.character_id == Character.id)
        .filter(
            SubtitleLine.episode_id == episode_id,
            Character.team_device_id.isnot(None),
            # "Усі" pseudo-actor (see routers/teams.py's get_team_actors) —
            # not a real device to Telegram-notify. Its lines already reach
            # everyone through export_srt_for_character's own merge, so
            # there's no one specific left to ping here.
            Character.team_device_id != "everyone",
        )
    )
    if only_character_id is not None:
        chars_query = chars_query.filter(Character.id == only_character_id)
    chars_with_lines = chars_query.distinct().all()
    if not chars_with_lines:
        return 0

    video_size_str = _format_size(video_size)

    sent = 0
    for char in chars_with_lines:
        try:
            char_line_count = (
                db.query(SubtitleLine)
                .filter(SubtitleLine.episode_id == episode_id, SubtitleLine.character_id == char.id)
                .count()
            )
            pct = (char_line_count / total_lines * 100) if total_lines else 0
            message = (
                f'Тобі призначено серію: "{title.name_ua if title else "?"}" — серія {ep.number}.\n'
                f"Твої репліки: {char_line_count} ({pct:.1f}%)\n"
                f"Відео з субтитрами (480p): {video_filename} ({video_size_str})"
            )
            if discovery_service.notify_device(char.team_device_id, message):
                sent += 1
        except Exception:
            app_logger.exception(
                "run_export_actor_video: per-actor notify failed episode=%s character=%s", episode_id, char.id,
            )
    return sent
