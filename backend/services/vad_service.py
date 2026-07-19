"""
Voice-activity detection on the isolated vocal stem.
Finds no-vocal gaps (background/SFX-only regions) above a threshold and
auto-places Reaper markers at each gap's start.

Uses silero-vad (PyTorch-based) as the primary VAD engine.
Falls back to simple RMS-energy thresholding if silero is unavailable.
"""
import os
import numpy as np
from pathlib import Path
from sqlalchemy.orm import Session
from typing import Optional

from ..models import Episode, Marker, SubtitleLine, Character
from ..database import SessionLocal
from ..job_manager import ProgressReporter

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))

# Gap must be at least this long (seconds) to place a marker
DEFAULT_MIN_GAP_SECONDS = 1.0


def run_marker_detection(
    episode_id: int,
    vocal_stem_path: str,
    char_codes: dict[str, Optional[str]],
    reporter: ProgressReporter,
    min_gap_seconds: float = DEFAULT_MIN_GAP_SECONDS,
) -> dict:
    """Opens its own DB session rather than reusing the request's — this runs
    in a background thread pool that outlives the HTTP request, and a
    request-scoped Session gets closed by FastAPI's dependency teardown right
    after the endpoint returns, well before this actually finishes."""
    db = SessionLocal()
    try:
        return _run_marker_detection(episode_id, vocal_stem_path, char_codes, reporter, db, min_gap_seconds)
    finally:
        db.close()


def _run_marker_detection(
    episode_id: int,
    vocal_stem_path: str,
    char_codes: dict[str, Optional[str]],
    reporter: ProgressReporter,
    db: Session,
    min_gap_seconds: float,
) -> dict:
    ep = db.get(Episode, episode_id)
    if not ep:
        raise ValueError(f"Episode {episode_id} not found")

    reporter.update(5, "Завантаження аудіо…")
    import soundfile as sf
    data, sr = sf.read(vocal_stem_path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)

    reporter.update(20, "VAD аналіз…")

    try:
        speech_timestamps = _silero_vad(mono, sr, reporter)
    except Exception:
        speech_timestamps = _energy_vad(mono, sr, min_gap_seconds)

    reporter.update(70, "Виявлення пауз…")

    duration_sec = len(mono) / sr
    # Convert speech timestamps to gap list
    gaps: list[tuple[float, float]] = []
    prev_end = 0.0

    for seg in speech_timestamps:
        start = seg["start"] / sr
        end = seg["end"] / sr
        gap_dur = start - prev_end
        if gap_dur >= min_gap_seconds:
            gaps.append((prev_end, start))
        prev_end = end

    # Final gap (after last speech to end)
    if duration_sec - prev_end >= min_gap_seconds:
        gaps.append((prev_end, duration_sec))

    # Determine marker names from subtitle context
    subtitle_lines = (
        db.query(SubtitleLine)
        .filter(SubtitleLine.episode_id == episode_id)
        .order_by(SubtitleLine.start_ms)
        .all()
    )

    # A gap already covered by an existing subtitle line (any overlap at all)
    # doesn't need its own "ЗВУК" marker — that stretch is already annotated,
    # e.g. a Sign/OP/ED line over an instrumental section with no vocal, which
    # VAD alone can't tell apart from a real background-sound-only gap.
    def _overlaps_subtitle(gap_start: float, gap_end: float) -> bool:
        gap_start_ms, gap_end_ms = gap_start * 1000, gap_end * 1000
        return any(line.start_ms < gap_end_ms and line.end_ms > gap_start_ms for line in subtitle_lines)

    gaps = [g for g in gaps if not _overlaps_subtitle(*g)]

    reporter.update(80, f"Знайдено {len(gaps)} пауз (поза субтитрами). Розміщення маркерів…")

    # Remove old auto-markers for this episode
    db.query(Marker).filter(Marker.episode_id == episode_id, Marker.confirmed == False).delete()

    new_markers: list[Marker] = []
    for gap_start, gap_end in gaps:
        gap_start_ms = int(gap_start * 1000)
        gap_end_ms = int(gap_end * 1000)

        # Find which characters speak in the window just after this gap
        nearby_lines = [
            l for l in subtitle_lines
            if l.start_ms >= gap_start_ms and l.start_ms <= gap_end_ms + 5000
        ]

        char_names: list[str] = []
        for line in nearby_lines[:3]:
            if line.character and line.character.code:
                c = line.character.code
            elif line.character:
                c = line.character.name[:2].upper()
            else:
                continue
            if c not in char_names:
                char_names.append(c)

        if char_names:
            name = ",".join(char_names) + " - ЗВУК"
        else:
            name = "ЗВУК"

        marker = Marker(
            episode_id=episode_id,
            reaper_name=name,
            position_seconds=gap_start,
            confirmed=False,
        )
        db.add(marker)
        new_markers.append(marker)

    ep.status = "marked"
    db.commit()

    reporter.update(100, f"Розміщено {len(new_markers)} маркерів")
    return {"marker_count": len(new_markers)}


def _silero_vad(mono: np.ndarray, sr: int, reporter: ProgressReporter) -> list[dict]:
    """Run silero-vad. Returns list of {start, end} sample indices."""
    import torch
    from silero_vad import load_silero_vad, get_speech_timestamps

    reporter.update(30, "Завантаження Silero VAD…")
    model = load_silero_vad()

    # Silero needs 16kHz
    if sr != 16000:
        import librosa
        mono_16k = librosa.resample(mono, orig_sr=sr, target_sr=16000)
        target_sr = 16000
    else:
        mono_16k = mono
        target_sr = 16000

    tensor = torch.from_numpy(mono_16k)
    reporter.update(45, "Силеро VAD…")
    timestamps = get_speech_timestamps(tensor, model, sampling_rate=target_sr)

    # Scale back to original sr
    scale = sr / target_sr
    return [{"start": int(t["start"] * scale), "end": int(t["end"] * scale)} for t in timestamps]


def _energy_vad(mono: np.ndarray, sr: int, min_gap_seconds: float) -> list[dict]:
    """Simple energy-based VAD fallback."""
    frame_ms = 20
    frame_len = int(sr * frame_ms / 1000)
    threshold = 0.01  # RMS threshold

    speech_frames: list[bool] = []
    for i in range(0, len(mono), frame_len):
        chunk = mono[i:i+frame_len]
        rms = float(np.sqrt(np.mean(chunk**2)))
        speech_frames.append(rms > threshold)

    # Smooth: if short silence (<0.1s) between speech, keep as speech
    smoothing_frames = int(0.1 * 1000 / frame_ms)
    for i in range(smoothing_frames, len(speech_frames) - smoothing_frames):
        if speech_frames[i-smoothing_frames] and speech_frames[i+smoothing_frames]:
            speech_frames[i] = True

    # Convert to timestamps
    timestamps = []
    in_speech = False
    start_sample = 0
    for i, is_speech in enumerate(speech_frames):
        sample = i * frame_len
        if is_speech and not in_speech:
            in_speech = True
            start_sample = sample
        elif not is_speech and in_speech:
            in_speech = False
            timestamps.append({"start": start_sample, "end": sample})
    if in_speech:
        timestamps.append({"start": start_sample, "end": len(mono)})

    return timestamps
