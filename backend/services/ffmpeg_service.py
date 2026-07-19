"""
ffmpeg pipeline:
  - import: extract full lossless audio, generate 480p proxy
  - mux: final mux with rendered audio against original video container
"""
import os
import subprocess
import json
import shutil
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import Episode
from ..database import SessionLocal
from ..job_manager import ProgressReporter

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


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

    # --- Extract lossless audio (FLAC) ---
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
        proc = subprocess.Popen(
            cmd_audio, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", errors="replace",
        )
        for line in proc.stderr:
            if is_cancelled and is_cancelled():
                proc.kill()
                raise RuntimeError("Скасовано")
            if "time=" in line and duration:
                try:
                    t = _parse_time(line)
                    pct = min(40, int(10 + 30 * t / duration))
                    progress(pct, "ffmpeg: витягую лосслес-аудіо (FLAC)…")
                except Exception:
                    pass
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg audio extraction failed")

    progress(45, "ffmpeg: генерую 480p проксі для перегляду…")

    # --- 480p proxy ---
    proxy_out = str(Path(out_dir) / "proxy_480p.mp4")
    if not os.path.isfile(proxy_out):
        cmd_proxy = [
            _ffmpeg_bin(), "-y",
            "-i", file_path,
            "-vf", "scale=-2:480",
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "28",
            "-c:a", "aac", "-b:a", "128k",
            proxy_out,
        ]
        proc = subprocess.Popen(
            cmd_proxy, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", errors="replace",
        )
        for line in proc.stderr:
            if is_cancelled and is_cancelled():
                proc.kill()
                raise RuntimeError("Скасовано")
            if "time=" in line and duration:
                try:
                    t = _parse_time(line)
                    pct = min(90, int(45 + 45 * t / duration))
                    progress(pct, "ffmpeg: генерую 480p проксі для перегляду…")
                except Exception:
                    pass
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg proxy generation failed")

    progress(100, "ffmpeg: аудіо й проксі готові")
    return {
        "audio_path": audio_out,
        "proxy_path": proxy_out,
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
    """Extract audio + generate 480p proxy. Separation (local or remote) is a
    deliberate next step the user triggers explicitly via a button — not
    auto-chained here — so they can choose to run it locally or request it
    from a peer over power-sharing before any processing actually starts.

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
            raise ValueError(f"Episode {episode_id} not found")

        ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)

        result = run_import_ffmpeg_only(
            file_path, str(ep_dir),
            on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
        )

        reporter.update(95, "Оновлюю базу даних…")

        ep.original_file_path = file_path
        ep.audio_stem_path = result["audio_path"]
        ep.proxy_480p_path = result["proxy_path"]
        ep.original_size = result["file_size"]
        ep.original_bitrate = result["bit_rate"]
        ep.original_format = result["format_name"]
        ep.duration = result["duration"]
        ep.status = "processing"
        db.commit()

        reporter.update(100, "Аудіо готове")
        return {"audio_path": result["audio_path"], "proxy_path": result["proxy_path"]}
    finally:
        db.close()


def run_mux_pipeline(
    episode_id: int,
    original_video_path: str,
    mixed_audio_path: str,
    reporter: ProgressReporter,
) -> dict:
    """Mux rendered audio against original video, keeping video stream untouched.
    Opens its own DB session — see run_import_pipeline's docstring for why."""
    db = SessionLocal()
    try:
        return _run_mux_pipeline(episode_id, original_video_path, mixed_audio_path, reporter, db)
    finally:
        db.close()


def _run_mux_pipeline(
    episode_id: int,
    original_video_path: str,
    mixed_audio_path: str,
    reporter: ProgressReporter,
    db: Session,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    ep_dir.mkdir(parents=True, exist_ok=True)

    reporter.update(5, "ffmpeg: аналіз оригінального відео…")
    probe = _probe(original_video_path)

    # Find original audio stream info
    audio_streams = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    orig_codec = audio_streams[0].get("codec_name", "aac") if audio_streams else "aac"
    orig_bitrate = str(int(audio_streams[0].get("bit_rate", "192000")) // 1000) + "k" if audio_streams else "192k"

    reporter.update(15, "ffmpeg: мультиплексую фінальне відео…")

    out_name = Path(original_video_path).stem + "_dub" + Path(original_video_path).suffix
    out_path = str(ep_dir / out_name)

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

    duration = ep.duration or 0
    proc = subprocess.Popen(
        cmd, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace",
    )
    for line in proc.stderr:
        if "time=" in line and duration:
            try:
                t = _parse_time(line)
                pct = min(90, int(15 + 75 * t / duration))
                reporter.update(pct, "ffmpeg: мультиплексую фінальне відео…")
            except Exception:
                pass
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg mux failed")

    ep.status = "ready"
    db.commit()

    reporter.update(100, "Готово")
    return {"output_path": out_path}


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
