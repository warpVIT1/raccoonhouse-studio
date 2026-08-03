"""
ffmpeg pipeline:
  - import: extract full lossless audio only — playback in the workspace uses
    the original video file directly (streamed as-is), not a transcoded proxy,
    so editing (subtitles, markers) is available the moment audio extraction
    finishes rather than waiting on a second, slower re-encode step.
  - mux: final mux with rendered audio against original video container
"""
import os
import subprocess
import json
import shutil
import threading
import time
from typing import Optional
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import Episode
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from .power_share_service import app_logger

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def _spawn_cancel_watcher(proc: "subprocess.Popen", is_cancelled) -> "threading.Event | None":
    """Kills `proc` the moment is_cancelled() flips true, polling on its own
    timer rather than relying on the stderr-reading loop to notice — that
    loop only checks between lines, so a subprocess that goes quiet for a
    stretch (no fresh 'time=' output, e.g. near the very end of a fast
    '-c:v copy' remux) kept running to completion after Cancel was clicked:
    the job was marked cancelled, but the ffmpeg process itself was not
    (confirmed live: progress froze at the percent shown when Cancel was
    hit, yet the render finished on disk anyway)."""
    if not is_cancelled:
        return None
    stop = threading.Event()

    def _watch():
        while not stop.is_set():
            if is_cancelled():
                proc.kill()
                return
            stop.wait(0.3)

    threading.Thread(target=_watch, daemon=True).start()
    return stop


def _ffmpeg_bin() -> str:
    # Check bundled first (packaged app: Electron passes RH_RESOURCES_DIR pointing
    # at resourcesPath/bin; dev: falls back to the project's resources/bin), then PATH.
    candidates = []
    resources_dir = os.environ.get("RH_RESOURCES_DIR")
    if resources_dir:
        candidates.append(os.path.join(resources_dir, "ffmpeg.exe"))
    candidates.append(os.path.join(os.path.dirname(__file__), "..", "..", "resources", "bin", "ffmpeg.exe"))
    candidates.append("ffmpeg")
    for c in candidates:
        if os.path.isfile(c) or shutil.which(c):
            return c
    return "ffmpeg"


def _ffprobe_bin() -> str:
    resources_dir = os.environ.get("RH_RESOURCES_DIR")
    candidates = []
    if resources_dir:
        candidates.append(os.path.join(resources_dir, "ffprobe.exe"))
    candidates.append(os.path.join(os.path.dirname(__file__), "..", "..", "resources", "bin", "ffprobe.exe"))
    candidates.append("ffprobe")
    for c in candidates:
        if os.path.isfile(c) or shutil.which(c):
            return c
    return "ffprobe"


def _probe(file_path: str) -> dict:
    cmd = [
        _ffprobe_bin(),
        "-v", "quiet",
        "-print_format", "json",
        "-show_format", "-show_streams",
        file_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        # fallback
        return {}
    return json.loads(result.stdout)


def run_import_ffmpeg_only(
    file_path: str,
    out_dir: str,
    on_progress=None,   # Optional[Callable[[int, str], None]] — no DB/job coupling
    is_cancelled=None,  # Optional[Callable[[], bool]]
) -> dict:
    """Core ffmpeg extraction routine, independent of any Episode/DB — used
    both for local import jobs (run_import_pipeline below) and for a
    power-shared import request run entirely on a peer machine (which has no
    record of this episode at all — see power_share.run-import). Every stage
    is prefixed 'ffmpeg:' so the UI never shows a bare, unexplained 'Обробка'
    without saying which of the two engines (ffmpeg vs. the neural separator)
    is actually running."""
    app_logger.info("run_import_ffmpeg_only: start file_path=%s out_dir=%s", file_path, out_dir)
    os.makedirs(out_dir, exist_ok=True)

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    progress(5, "ffmpeg: аналіз відеофайлу…")

    probe = _probe(file_path)
    fmt = probe.get("format", {})
    file_size = os.path.getsize(file_path)
    duration = float(fmt.get("duration", 0)) or None
    bit_rate = int(fmt.get("bit_rate", 0)) // 1000 or None  # kbps
    fmt_name = fmt.get("format_name", "").split(",")[0]

    progress(10, "ffmpeg: витягую лосслес-аудіо (FLAC)…")

    # --- Extract lossless audio (FLAC) — the only ffmpeg step on import now.
    # Playback uses the original file directly (see /stream + VideoPlayer),
    # so subtitles/markers/actors are editable as soon as THIS finishes,
    # without also waiting on a 480p transcode that isn't needed for editing.
    audio_out = str(Path(out_dir) / "audio_full.flac")
    if not os.path.isfile(audio_out):
        cmd_audio = [
            _ffmpeg_bin(), "-y",
            "-i", file_path,
            "-vn",           # no video
            "-c:a", "flac",  # lossless
            "-compression_level", "0",  # fastest
            audio_out,
        ]
        app_logger.info("run_import_ffmpeg_only: running ffmpeg: %s", " ".join(cmd_audio))
        proc = subprocess.Popen(
            cmd_audio, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", errors="replace",
        )
        watcher = _spawn_cancel_watcher(proc, is_cancelled)
        try:
            stderr_tail: list[str] = []
            for line in proc.stderr:
                stderr_tail.append(line)
                if len(stderr_tail) > 200:
                    stderr_tail.pop(0)
                if is_cancelled and is_cancelled():
                    proc.kill()
                    raise RuntimeError("Скасовано")
                if "time=" in line and duration:
                    try:
                        t = _parse_time(line)
                        pct = min(95, int(10 + 85 * t / duration))
                        progress(pct, "ffmpeg: витягую лосслес-аудіо (FLAC)…")
                    except Exception:
                        pass
            proc.wait()
        finally:
            if watcher:
                watcher.set()
        if is_cancelled and is_cancelled():
            raise RuntimeError("Скасовано")
        if proc.returncode != 0:
            app_logger.error(
                "run_import_ffmpeg_only: ffmpeg exited with code %s, last output:\n%s",
                proc.returncode, "".join(stderr_tail),
            )
            raise RuntimeError("ffmpeg audio extraction failed")

    progress(100, "ffmpeg: аудіо готове")
    return {
        "audio_path": audio_out,
        "file_size": file_size,
        "duration": duration,
        "bit_rate": bit_rate,
        "format_name": fmt_name,
    }


def run_import_pipeline(
    episode_id: int,
    file_path: str,
    reporter: ProgressReporter,
) -> dict:
    """Extract audio. Separation (local or remote) is a deliberate next step
    the user triggers explicitly via a button — not auto-chained here — so
    they can choose to run it locally or request it from a peer over
    power-sharing before any processing actually starts. Playback in the
    workspace uses the original file directly (no proxy transcode), so
    subtitles/markers are editable the moment this one ffmpeg step finishes.

    Opens its own DB session rather than reusing the request's — this runs in
    a background thread pool that outlives the HTTP request, and a request-
    scoped SQLAlchemy Session gets closed by FastAPI's dependency teardown as
    soon as the endpoint returns, well before this actually finishes; reusing
    it across threads/after close intermittently raises
    "identity map is no longer valid" once real work (not just an instant
    no-op) happens between the two."""
    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep:
            app_logger.error("run_import_pipeline: episode %s not found", episode_id)
            raise ValueError(f"Episode {episode_id} not found")

        ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)

        try:
            result = run_import_ffmpeg_only(
                file_path, str(ep_dir),
                on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
            )
        except Exception:
            app_logger.exception("run_import_pipeline: failed for episode %s (file=%s)", episode_id, file_path)
            raise

        reporter.update(95, "Оновлюю базу даних…")

        ep.original_file_path = file_path
        ep.audio_stem_path = result["audio_path"]
        ep.original_size = result["file_size"]
        ep.original_bitrate = result["bit_rate"]
        ep.original_format = result["format_name"]
        ep.duration = result["duration"]
        ep.status = "processing"
        db.commit()
        app_logger.info("run_import_pipeline: episode %s done, audio_path=%s", episode_id, result["audio_path"])

        reporter.update(100, "Аудіо готове")
        return {"audio_path": result["audio_path"]}
    finally:
        db.close()


def run_mux_ffmpeg_only(
    original_video_path: str,
    mixed_audio_path: str,
    out_dir: str,
    duration: Optional[float] = None,
    on_progress=None,   # Optional[Callable[[int, str], None]] — no DB/job coupling
    is_cancelled=None,  # Optional[Callable[[], bool]]
) -> dict:
    """Core ffmpeg mux routine, independent of any Episode/DB — used both for
    local render (run_mux_pipeline below) and a power-shared render request
    run entirely on a peer machine (which has no record of this episode at
    all — see power_share_service.run_render_job_for_peer). Mirrors
    run_import_ffmpeg_only's split between a pure-ffmpeg core and a DB-aware
    wrapper for the same reason."""
    os.makedirs(out_dir, exist_ok=True)

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    progress(5, "ffmpeg: аналіз оригінального відео…")
    probe = _probe(original_video_path)

    # Find original audio stream info
    audio_streams = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    orig_codec = audio_streams[0].get("codec_name", "aac") if audio_streams else "aac"
    orig_bitrate = str(int(audio_streams[0].get("bit_rate", "192000")) // 1000) + "k" if audio_streams else "192k"
    if not duration:
        duration = float(probe.get("format", {}).get("duration", 0)) or 0

    progress(15, "ffmpeg: мультиплексую фінальне відео…")

    out_name = Path(original_video_path).stem + "_dub" + Path(original_video_path).suffix
    out_path = str(Path(out_dir) / out_name)

    cmd = [
        _ffmpeg_bin(), "-y",
        "-i", original_video_path,
        "-i", mixed_audio_path,
        "-map", "0:v",          # video from original
        "-map", "1:a",          # audio from mixed
        "-c:v", "copy",         # no re-encode video
        "-c:a", orig_codec,
        "-b:a", orig_bitrate,
        out_path,
    ]

    app_logger.info("run_mux_ffmpeg_only: running ffmpeg: %s", " ".join(cmd))
    proc = subprocess.Popen(
        cmd, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace",
    )
    watcher = _spawn_cancel_watcher(proc, is_cancelled)
    try:
        stderr_tail: list[str] = []
        for line in proc.stderr:
            stderr_tail.append(line)
            if len(stderr_tail) > 200:
                stderr_tail.pop(0)
            if is_cancelled and is_cancelled():
                proc.kill()
                raise RuntimeError("Скасовано")
            if "time=" in line and duration:
                try:
                    t = _parse_time(line)
                    pct = min(90, int(15 + 75 * t / duration))
                    progress(pct, "ffmpeg: мультиплексую фінальне відео…")
                except Exception:
                    pass
        proc.wait()
    finally:
        if watcher:
            watcher.set()
    if is_cancelled and is_cancelled():
        raise RuntimeError("Скасовано")
    if proc.returncode != 0:
        app_logger.error(
            "run_mux_ffmpeg_only: ffmpeg exited with code %s, last output:\n%s",
            proc.returncode, "".join(stderr_tail),
        )
        raise RuntimeError("ffmpeg mux failed")

    # Alongside the muxed video, also keep a standalone lossless FLAC of the
    # exact same audio that went into it — the video's own audio track gets
    # re-encoded above to match the ORIGINAL container's codec (often lossy,
    # e.g. AAC), so this is the only copy of the final dub audio that stays
    # bit-for-bit lossless, useful on its own (Reaper, archival) without
    # needing to re-extract it from the video.
    progress(95, "ffmpeg: зберігаю аудіо окремим FLAC-файлом…")
    flac_out_path = str(Path(out_dir) / (Path(original_video_path).stem + "_dub.flac"))
    _ensure_flac_copy(mixed_audio_path, flac_out_path)

    progress(100, "Готово")
    return {"output_path": out_path, "audio_output_path": flac_out_path}


def convert_to_flac(input_path: str, output_path: str) -> str:
    """Lossless re-encode to FLAC — used to shrink an uncompressed instrumental
    WAV before uploading it to a power-share peer for a remote render (see
    power_share_service.request_remote_render); FLAC roughly halves a PCM
    WAV's size losslessly, cutting transfer time without touching quality."""
    cmd = [_ffmpeg_bin(), "-y", "-i", input_path, "-c:a", "flac", "-compression_level", "5", output_path]
    app_logger.info("convert_to_flac: running ffmpeg: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        app_logger.error("convert_to_flac: ffmpeg exited with code %s: %s", result.returncode, result.stderr[-2000:])
        raise RuntimeError("ffmpeg FLAC conversion failed")
    return output_path


def _ensure_flac_copy(source_path: str, dest_path: str) -> str:
    """Produces a FLAC file at dest_path from source_path — a plain copy if
    source is already FLAC (a power-share render's instrumental always is,
    see power_share_service.request_remote_render), otherwise a lossless
    ffmpeg re-encode (a local render's instrumental is WAV)."""
    if Path(source_path).suffix.lower() == ".flac":
        shutil.copy2(source_path, dest_path)
        return dest_path
    return convert_to_flac(source_path, dest_path)


def run_mux_pipeline(
    episode_id: int,
    original_video_path: str,
    mixed_audio_path: str,
    reporter: ProgressReporter,
    output_dir: Optional[str] = None,
) -> dict:
    """Mux rendered audio against original video, keeping video stream untouched.
    Opens its own DB session — see run_import_pipeline's docstring for why."""
    db = SessionLocal()
    try:
        return _run_mux_pipeline(episode_id, original_video_path, mixed_audio_path, reporter, db, output_dir)
    finally:
        db.close()


def _run_mux_pipeline(
    episode_id: int,
    original_video_path: str,
    mixed_audio_path: str,
    reporter: ProgressReporter,
    db: Session,
    output_dir: Optional[str] = None,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        app_logger.error("_run_mux_pipeline: episode %s not found", episode_id)
        raise ValueError(f"Episode {episode_id} not found")
    app_logger.info(
        "_run_mux_pipeline: start episode=%s video=%s audio=%s output_dir=%s",
        episode_id, original_video_path, mixed_audio_path, output_dir,
    )

    # User-picked destination (native folder dialog) if given, otherwise the
    # episode's own data-dir folder as before.
    out_dir = Path(output_dir) if output_dir else Path(DATA_DIR) / "episodes" / str(episode_id)

    result = run_mux_ffmpeg_only(
        original_video_path, mixed_audio_path, str(out_dir), duration=ep.duration,
        on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
    )

    ep.status = "ready"
    db.commit()
    app_logger.info("_run_mux_pipeline: episode %s done, output=%s", episode_id, result["output_path"])
    return result


def get_waveform_samples(audio_path: str, num_samples: int = 2000) -> tuple[list[float], float, int]:
    """Return downsampled RMS amplitude array for waveform display."""
    try:
        import soundfile as sf
        import numpy as np

        data, sr = sf.read(audio_path, dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        duration = len(mono) / sr

        # Chunk into num_samples windows
        chunk_size = max(1, len(mono) // num_samples)
        chunks = [mono[i:i+chunk_size] for i in range(0, len(mono), chunk_size)]
        rms = [float(np.sqrt(np.mean(c**2))) for c in chunks[:num_samples]]

        # Normalize 0–1
        max_rms = max(rms) if rms else 1.0
        if max_rms > 0:
            rms = [v / max_rms for v in rms]

        return rms, duration, sr
    except Exception:
        return [], 0.0, 48000


def _parse_time(line: str) -> float:
    """Parse HH:MM:SS.ms from ffmpeg's progress output."""
    idx = line.find("time=")
    if idx < 0:
        return 0
    t_str = line[idx+5:idx+16].strip()
    parts = t_str.split(":")
    if len(parts) == 3:
        return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    return 0
