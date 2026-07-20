"""
Voice-activity detection on the isolated vocal stem.
Finds no-vocal gaps (background/SFX-only regions) above a threshold and
auto-places Reaper markers at each gap's start.

Uses silero-vad (PyTorch-based) as the primary VAD engine.
Falls back to simple RMS-energy thresholding if silero is unavailable.
"""
import logging
import os
import numpy as np
from pathlib import Path
from sqlalchemy.orm import Session
from typing import Optional

from ..models import Episode, Marker, SubtitleLine, Character
from ..database import SessionLocal
from ..job_manager import ProgressReporter

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
logger = logging.getLogger(__name__)

# Gap must be at least this long (seconds) to place a marker
DEFAULT_MIN_GAP_SECONDS = 1.0

# Minimum length (seconds) for a гуртівка (background crowd babble) region to
# get its own початок/кінець marker pair — shorter blips are more likely a
# brief noise spike than sustained crowd chatter.
GURTIVKA_MIN_DURATION_SECONDS = 2.0
GURTIVKA_COLOR = "#4ADE80"
# The "початок" marker sits slightly ahead of the detected onset — markers
# mark the moment to prepare for a sound, not the moment it's already
# started (matches the "перед звуком, не після" requirement).
GURTIVKA_LEAD_SECONDS = 0.3


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
        logger.exception("Silero VAD failed, falling back to energy-threshold VAD")
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

    reporter.update(85, "Пошук гуртівки…")
    gurtivka_regions = _detect_gurtivka(mono, sr)
    for g_start, g_end in gurtivka_regions:
        start_marker = Marker(
            episode_id=episode_id, reaper_name="ГУРТІВКА - початок",
            position_seconds=max(0.0, g_start - GURTIVKA_LEAD_SECONDS), confirmed=False, color=GURTIVKA_COLOR,
        )
        end_marker = Marker(
            episode_id=episode_id, reaper_name="ГУРТІВКА - кінець",
            position_seconds=g_end, confirmed=False, color=GURTIVKA_COLOR,
        )
        db.add(start_marker)
        db.add(end_marker)
        new_markers.append(start_marker)
        new_markers.append(end_marker)

    ep.status = "marked"
    db.commit()

    reporter.update(100, f"Розміщено {len(new_markers)} маркерів")
    return {"marker_count": len(new_markers)}


def _detect_gurtivka(mono: np.ndarray, sr: int) -> list[tuple[float, float]]:
    """Heuristic detection of гуртівка (many people talking in the
    background at once) — deliberately independent of silero's speech/gap
    split above, and NOT suppressed by subtitle overlap, since gуртівка can
    happen either under dialogue or in a silent stretch just the same.

    There's no trained classifier for this and no labeled гуртівка audio to
    validate against, so this is a heuristic, not ground truth: many
    overlapping voices don't share one clean spectral shape the way a
    single speaker does, so a frame is flagged when it has real acoustic
    energy, a noise-like (flat) spectrum, and wide spectral bandwidth —
    all signs of several simultaneous sound sources rather than one clear
    voice. Expect to tune GURTIVKA_MIN_DURATION_SECONDS and the percentile
    thresholds below against real episodes rather than trusting these
    defaults blindly.

    Deliberately NOT using pitch-tracking (librosa.pyin) here even though
    it's a more direct signal for "one voice vs many" — pyin's per-frame
    search doesn't release the GIL in any meaningful way, so it blocks the
    ENTIRE backend process (not just this job) for its whole runtime, which
    for a full episode at any sample rate was still unfinished after several
    minutes (confirmed live 2026-07-19, including downsampled to 8kHz — the
    frame count drops but the per-frame cost dominates). The features below
    are all plain FFT-based and fully vectorized, so they run in seconds."""
    import librosa

    hop_length = 512
    flatness = librosa.feature.spectral_flatness(y=mono, hop_length=hop_length)[0]
    bandwidth = librosa.feature.spectral_bandwidth(y=mono, sr=sr, hop_length=hop_length)[0]
    rms = librosa.feature.rms(y=mono, hop_length=hop_length)[0]

    n = min(len(flatness), len(bandwidth), len(rms))
    if n == 0:
        return []
    flatness = flatness[:n]
    bandwidth = bandwidth[:n]
    rms = rms[:n]
    times = librosa.frames_to_time(np.arange(n), sr=sr, hop_length=hop_length)

    # Thresholds relative to THIS episode's own loudness/spectrum rather than
    # fixed absolute numbers — mix loudness varies a lot episode to episode.
    energy_threshold = np.percentile(rms, 40)
    flatness_threshold = np.percentile(flatness, 60)
    bandwidth_threshold = np.percentile(bandwidth, 60)
    is_crowdish = (rms > energy_threshold) & (flatness > flatness_threshold) & (bandwidth > bandwidth_threshold)

    # Raw per-frame flags flicker frame-to-frame even within a genuine
    # gуртівка stretch (a brief dip in one feature breaks the run) — confirmed
    # live 2026-07-19: ~11% of frames flagged episode-wide, but the longest
    # RAW contiguous run was ~1.1s even though clearly-sustained stretches
    # should exist. Smooth with a 1-second rolling average and threshold
    # THAT instead of requiring every single frame in a row to pass.
    smooth_window_frames = max(1, int(1.0 * sr / hop_length))
    kernel = np.ones(smooth_window_frames) / smooth_window_frames
    crowdish_fraction = np.convolve(is_crowdish.astype(float), kernel, mode="same")
    is_crowdish = crowdish_fraction > 0.5

    regions: list[tuple[float, float]] = []
    start_idx: Optional[int] = None
    for i, flag in enumerate(is_crowdish):
        if flag and start_idx is None:
            start_idx = i
        elif not flag and start_idx is not None:
            if times[i] - times[start_idx] >= GURTIVKA_MIN_DURATION_SECONDS:
                regions.append((float(times[start_idx]), float(times[i])))
            start_idx = None
    if start_idx is not None and times[n - 1] - times[start_idx] >= GURTIVKA_MIN_DURATION_SECONDS:
        regions.append((float(times[start_idx]), float(times[n - 1])))

    logger.info("Гуртівка heuristic found %d region(s): %s", len(regions), regions)
    return regions


def _stub_torchaudio_if_broken() -> None:
    """silero_vad's utils_vad.py unconditionally imports torchaudio at
    module level — but only to support its own read_audio()/save_audio()
    file-I/O helpers, which this app never calls (audio loading here goes
    through soundfile + librosa instead, see _run_marker_detection above).
    torchaudio's release train froze at 2.11.0 (project deprecated) while
    torch here is 2.13.0 — its compiled extension no longer loads against
    that torch build at all (confirmed live 2026-07-19:
    "OSError: Could not load this library: .../torchaudio/lib/libtorchaudio.pyd"),
    which without this would make _silero_vad() throw immediately on import
    and silently fall back to the much cruder energy-threshold VAD below —
    every single run, with no visible error anywhere. Rather than downgrade
    torch project-wide for a dependency our own code path never exercises,
    swap in a bare stand-in module before silero_vad ever imports the real
    one — safe only because nothing here calls torchaudio.load/save/transforms."""
    import sys
    if "torchaudio" in sys.modules:
        return
    try:
        import torchaudio  # noqa: F401 — works fine, nothing to stub
        return
    except Exception:
        pass
    import types
    stub = types.ModuleType("torchaudio")
    stub.__version__ = "0.0.0"
    sys.modules["torchaudio"] = stub


def _silero_vad(mono: np.ndarray, sr: int, reporter: ProgressReporter) -> list[dict]:
    """Run silero-vad. Returns list of {start, end} sample indices."""
    import torch
    _stub_torchaudio_if_broken()
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
