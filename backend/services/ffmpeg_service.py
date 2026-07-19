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


def run_import_pipeline(
    episode_id: int,
    file_path: str,
    reporter: ProgressReporter,
    db: Session,
) -> dict:
    """Extract audio + generate 480p proxy. Separation (local or remote) is a
    deliberate next step the user triggers explicitly via a button — not
    auto-chained here — so they can choose to run it locally or request it
    from a peer over power-sharing before any processing actually starts."""
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    ep_dir.mkdir(parents=True, exist_ok=True)

    def ff_progress(pct, msg):
        reporter.update(pct, msg)

    ff_progress(5, "Аналіз відеофайлу…")

    # Probe
    probe = _probe(file_path)
    fmt = probe.get("format", {})
    file_size = os.path.getsize(file_path)
    duration = float(fmt.get("duration", 0)) or None
    bit_rate = int(fmt.get("bit_rate", 0)) // 1000 or None  # kbps
    fmt_name = fmt.get("format_name", "").split(",")[0]

    ff_progress(10, "Витягую аудіо…")

    # --- Extract lossless audio (FLAC) ---
    audio_out = str(ep_dir / "audio_full.flac")
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
        # Parse progress from ffmpeg stderr
        for line in proc.stderr:
            if reporter.cancelled:
                proc.kill()
                raise RuntimeError("Скасовано")
            if "time=" in line and duration:
                try:
                    t = _parse_time(line)
                    pct = min(40, int(10 + 30 * t / duration))
                    ff_progress(pct, "Витягую аудіо…")
                except Exception:
                    pass
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg audio extraction failed")

    ff_progress(45, "Генерую 480p проксі…")

    # --- 480p proxy ---
    proxy_out = str(ep_dir / "proxy_480p.mp4")
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
            if reporter.cancelled:
                proc.kill()
                raise RuntimeError("Скасовано")
            if "time=" in line and duration:
                try:
                    t = _parse_time(line)
                    pct = min(90, int(45 + 45 * t / duration))
                    ff_progress(pct, "Генерую 480p проксі…")
                except Exception:
                    pass
        proc.wait()
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg proxy generation failed")

    ff_progress(95, "Оновлюю базу даних…")

    # Update episode
    ep.original_file_path = file_path
    ep.audio_stem_path = audio_out
    ep.proxy_480p_path = proxy_out
    ep.original_size = file_size
    ep.original_bitrate = bit_rate
    ep.original_format = fmt_name
    ep.duration = duration
    ep.status = "processing"
    db.commit()

    ff_progress(100, "Аудіо готове")
    return {"audio_path": audio_out, "proxy_path": proxy_out}


def run_mux_pipeline(
    episode_id: int,
    original_video_path: str,
    mixed_audio_path: str,
    reporter: ProgressReporter,
    db: Session,
) -> dict:
    """Mux rendered audio against original video, keeping video stream untouched."""
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
    ep_dir.mkdir(parents=True, exist_ok=True)

    reporter.update(5, "Аналіз оригінального відео…")
    probe = _probe(original_video_path)

    # Find original audio stream info
    audio_streams = [s for s in probe.get("streams", []) if s.get("codec_type") == "audio"]
    orig_codec = audio_streams[0].get("codec_name", "aac") if audio_streams else "aac"
    orig_bitrate = str(int(audio_streams[0].get("bit_rate", "192000")) // 1000) + "k" if audio_streams else "192k"

    reporter.update(15, "Мультиплексую…")

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
                reporter.update(pct, "Мультиплексую…")
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
