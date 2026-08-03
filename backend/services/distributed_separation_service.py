"""
Distributed vocal separation: splits an episode's audio into N segments
(N = 1 local chunk + however many online Power Share peers say Так in this
round) and runs each segment's separation IN PARALLEL — the local machine on
its own chunk, each accepting peer on theirs, via the exact same job_request/
"separate" protocol single-peer power-share already uses (see
power_share_service.py's run_separation_job_for_peer / discovery_service.py's
_handle_job_request) — then stitches the resulting instrumental chunks back
into one continuous file with a short linear crossfade at each internal cut
point so the seams aren't audible.

Deliberately reuses the single-peer consent/transfer machinery as-is rather
than inventing a parallel protocol: a peer given a chunk has no idea it's
part of a larger split job — from its side, this looks identical to being
asked to separate a short episode. All the "N machines, split, reassemble"
complexity lives here, on the requester side only.

Falls back to plain local separation (separator_service.run_separation) if
zero peers are online/willing, or if the episode is too short to usefully
split — "distributed" is strictly additive, never a harder requirement than
the normal path.

Each chunk's pure-vocal stem (needed by detect-markers) crosses the wire
alongside its instrumental now, same as single-peer power-share (see
run_separation_job_for_peer's docstring) — so vocal_only_stem_path gets
stitched together and set here too, as long as every chunk actually produced
one; if any chunk's vocal-only stem is missing for any reason, the whole
episode's vocal_only_stem_path is left unset rather than stitched from a
partial/misaligned set of chunks (detect-markers already has a clear error
message for that case — see episodes.py's detect_markers endpoint).
"""
import os
import shutil
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from ..models import Episode, Title, PowerShareConsent, SubtitleLine
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from . import separator_service
from .power_share_service import (
    power_logger, _active_profile_name, _ask_peer, DATA_DIR,
)
from .title_status import bump_title_in_progress

# Splitting a 2-minute clip five ways just to shave off a few seconds isn't
# worth the overlap/stitch overhead or the extra network round-trips — below
# this per-chunk length, just run the whole thing on one machine (whichever
# `separator_service.run_separation`'s normal path would already use).
MIN_CHUNK_SECONDS = 60.0

# Each internal cut gets this much shared overlap, linearly crossfaded on
# reassembly — long enough to hide a model's edge artifacts, short enough
# not to meaningfully add to total processing time.
OVERLAP_SECONDS = 6.0

# How far around a nominal chunk boundary to search for an actual quiet
# moment (see _find_quiet_point) — cutting a line/word in half mid-syllable
# would be far worse than an inaudible seam, so a boundary never sits at a
# raw fixed timestamp; it's nudged to the quietest nearby instant instead.
# Kept comfortably under half of MIN_CHUNK_SECONDS so two adjacent search
# windows can never overlap each other (chunks are always spaced at least
# MIN_CHUNK_SECONDS apart) and cut points stay guaranteed in order.
CUT_SEARCH_RADIUS_SECONDS = 15.0
_ENERGY_FRAME_MS = 20


def _gather_all_peers(title_id: int, title_name: str, episode_number: int, task: str, reporter, db) -> list[dict]:
    """Like power_share_service._acquire_peer, but waits for EVERY peer's
    answer (up to the same per-peer timeout _ask_peer already uses) instead
    of stopping at the first Так — distributed mode wants to use as many
    willing machines as there are, not just one."""
    from . import discovery_service

    peers = [p for p in discovery_service.get_discovered_peers() if p["power_share_enabled"] and p["logged_in"]]
    if not peers:
        return []

    payload = {
        "requester_name": _active_profile_name(db),
        "title_id": title_id, "title_name": title_name, "episode_number": episode_number,
    }
    if reporter:
        names = ", ".join(p["name"] for p in peers)
        reporter.update(5, f"Розподілена обробка: питаю всіх доступних ({names})…")
    power_logger.info(
        "DISTRIBUTED-BROADCAST title=%s ep=%s task=%s peers=%s",
        title_name, episode_number, task, [p["id"] for p in peers],
    )

    accepted: list[dict] = []
    with ThreadPoolExecutor(max_workers=max(1, len(peers))) as pool:
        futures = [pool.submit(_ask_peer, p, task, payload) for p in peers]
        for future in as_completed(futures):
            peer, approved, reason = future.result()
            if approved:
                accepted.append(peer)
                db.add(PowerShareConsent(peer_host=peer["id"], title_id=title_id, granted=True))
    db.commit()
    power_logger.info("DISTRIBUTED-ACCEPTED title=%s peers=%s", title_name, [p["id"] for p in accepted])
    return accepted


def _find_quiet_point(audio_path: str, target_sec: float, radius_sec: float, total_duration: float) -> float:
    """Looks for the quietest short moment within `radius_sec` of
    `target_sec` and returns its timestamp — used to nudge a chunk boundary
    away from an arbitrary fixed instant and into an actual gap between
    words or lines, so a cut never lands mid-syllable. Same 20ms-frame
    RMS-energy idea vad_service.py's own fallback VAD uses — full
    speech/silence segmentation (or silero) isn't needed here, just "the
    quietest nearby instant" on the ORIGINAL mixed track (this runs before
    separation, so there's no isolated vocal stem to search yet)."""
    window_start = max(0.0, target_sec - radius_sec)
    window_end = min(total_duration, target_sec + radius_sec)
    with sf.SoundFile(audio_path) as f:
        sr = f.samplerate
        start_frame = int(window_start * sr)
        end_frame = min(int(window_end * sr), len(f))
        f.seek(start_frame)
        data = f.read(max(0, end_frame - start_frame), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)

    frame_len = max(1, int(sr * _ENERGY_FRAME_MS / 1000))
    if len(mono) < frame_len:
        return target_sec

    best_offset = 0
    best_rms = float("inf")
    for i in range(0, len(mono) - frame_len, frame_len):
        chunk = mono[i:i + frame_len]
        rms = float(np.sqrt(np.mean(chunk ** 2)))
        if rms < best_rms:
            best_rms = rms
            best_offset = i

    return window_start + best_offset / sr


def _find_cut_point(
    subtitle_gaps: list[float],
    audio_path: str,
    nominal_sec: float,
    radius_sec: float,
    total_duration: float,
) -> float:
    """Picks where to actually cut near `nominal_sec`. Prefers the midpoint
    of the nearest gap BETWEEN two subtitle lines (реплiки) if this episode
    already has subtitles imported (e.g. from an ASS file) — that's a known-
    correct silence, unlike guessed energy levels, and directly avoids ever
    cutting a line/word in half. Only falls back to RMS-energy silence
    search (see _find_quiet_point) if there's no subtitle data yet — which is
    common, since subtitles are usually imported independently of when
    separation runs — or no subtitle gap sits within a widened search range."""
    if subtitle_gaps:
        nearest = min(subtitle_gaps, key=lambda g: abs(g - nominal_sec))
        if abs(nearest - nominal_sec) <= radius_sec * 2:
            return nearest
    return _find_quiet_point(audio_path, nominal_sec, radius_sec, total_duration)


def _cut_audio_chunk(audio_path: str, start_sec: float, end_sec: float, output_path: str) -> None:
    """Sample-accurate sub-segment extraction via soundfile — reads only the
    requested frame range (not the whole file), so this stays cheap even for
    a full-length episode."""
    with sf.SoundFile(audio_path) as f:
        sr = f.samplerate
        start_frame = int(start_sec * sr)
        end_frame = min(int(end_sec * sr), len(f))
        f.seek(start_frame)
        data = f.read(max(0, end_frame - start_frame), dtype="float32", always_2d=True)
    sf.write(output_path, data, sr)


def _crossfade_stitch(
    chunk_paths: list[str],
    chunk_bounds: list[tuple[float, float]],
    total_duration: float,
    overlap_sec: float,
    output_path: str,
) -> None:
    """Overlap-add reassembly: each chunk (except the first/last) fades in
    linearly over `overlap_sec` at its start and fades out linearly over
    `overlap_sec` at its end. Since a fade-out and the next chunk's fade-in
    cover the exact same region and sum to 1 at every sample, simply adding
    every chunk's (gain-applied) samples into one output buffer at its own
    time offset reproduces a standard linear crossfade with no separate
    weight-tracking needed."""
    with sf.SoundFile(chunk_paths[0]) as f0:
        sr = f0.samplerate
        channels = f0.channels

    total_frames = int(total_duration * sr) + 1
    output = np.zeros((total_frames, channels), dtype=np.float32)
    overlap_frames = int(overlap_sec * sr)

    for i, (path, (start_sec, _end_sec)) in enumerate(zip(chunk_paths, chunk_bounds)):
        data, _ = sf.read(path, dtype="float32", always_2d=True)
        n = data.shape[0]
        gain = np.ones(n, dtype=np.float32)
        if i > 0:
            fade_len = min(overlap_frames, n)
            gain[:fade_len] *= np.linspace(0.0, 1.0, fade_len, dtype=np.float32)
        if i < len(chunk_paths) - 1:
            fade_len = min(overlap_frames, n)
            gain[n - fade_len:] *= np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
        data *= gain[:, None]

        out_start = int(start_sec * sr)
        out_end = min(out_start + n, total_frames)
        output[out_start:out_end] += data[: out_end - out_start]

    sf.write(output_path, output, sr, subtype="PCM_24")


def run_distributed_separation(
    episode_id: int,
    model: str,
    ensemble: bool,
    reporter: ProgressReporter,
    model_file: Optional[str] = None,
    params: Optional[dict] = None,
) -> dict:
    """Opens its own DB session — this runs in a background thread pool that
    outlives the HTTP request, same reasoning as every other *_for_peer/
    run_* function in this codebase (see run_separation's docstring)."""
    from . import discovery_service

    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep:
            raise ValueError(f"Episode {episode_id} not found")
        title = db.get(Title, ep.title_id)
        if not title:
            raise ValueError("Title not found")
        if not ep.audio_stem_path or not os.path.isfile(ep.audio_stem_path):
            raise ValueError("Аудіодоріжка не знайдена — спершу імпортуйте відео")

        # Extract plain values up front — the chunk-processing closures below
        # run in worker threads, and ORM objects bound to this Session aren't
        # safe to touch from another thread (see episodes.py's own pattern of
        # pulling plain values out before asyncio.create_task).
        audio_path = ep.audio_stem_path
        title_name = title.name_ua
        ep_number = ep.number
        requester_name = _active_profile_name(db)

        with sf.SoundFile(audio_path) as f:
            sr = f.samplerate
            total_duration = len(f) / sr

        accepted_peers = _gather_all_peers(title.id, title_name, ep_number, "separate", reporter, db)
        num_chunks = len(accepted_peers) + 1

        if num_chunks == 1 or total_duration / num_chunks < MIN_CHUNK_SECONDS:
            if reporter:
                reason = "немає доступних ПК" if num_chunks == 1 else "епізод закороткий для розбиття"
                reporter.update(20, f"Розподілена обробка недоступна ({reason}) — обробляю локально…")
            return separator_service.run_separation(
                episode_id, audio_path, model, ensemble, reporter,
                model_file=model_file, params=params,
            )

        with separator_service._report_separation_run(episode_id, model, ensemble, distributed=True) as report_ctx:
            # --- Chunk boundaries: N roughly-equal spans, but each INTERNAL
            # cut point is nudged to the quietest nearby instant (see
            # _find_quiet_point) rather than sitting at a raw fixed
            # timestamp — otherwise a cut could land in the middle of a
            # spoken word/line. Each edge is then extended by half the
            # overlap into its neighbor's territory for the crossfade. ---
            base_len = total_duration / num_chunks
            if reporter:
                reporter.update(15, "Шукаю паузи між репліками для розрізів…")

            lines = (
                db.query(SubtitleLine)
                .filter(SubtitleLine.episode_id == episode_id)
                .order_by(SubtitleLine.start_ms)
                .all()
            )
            subtitle_gaps = [
                (a.end_ms + b.start_ms) / 2 / 1000
                for a, b in zip(lines, lines[1:])
                if b.start_ms > a.end_ms
            ]

            cut_points = [0.0]
            for i in range(1, num_chunks):
                nominal = i * base_len
                cut_points.append(_find_cut_point(subtitle_gaps, audio_path, nominal, CUT_SEARCH_RADIUS_SECONDS, total_duration))
            cut_points.append(total_duration)

            bounds: list[tuple[float, float]] = []
            for i in range(num_chunks):
                start = max(0.0, cut_points[i] - OVERLAP_SECONDS / 2) if i > 0 else 0.0
                end = min(total_duration, cut_points[i + 1] + OVERLAP_SECONDS / 2) if i < num_chunks - 1 else total_duration
                bounds.append((start, end))

            work_dir = Path(tempfile.mkdtemp(prefix="rh_distributed_"))
            ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
            output_dir = ep_dir / "stems"
            output_dir.mkdir(parents=True, exist_ok=True)

            results: dict[int, str] = {}   # chunk_index -> instrumental wav path
            vocal_only_results: dict[int, Optional[str]] = {}  # chunk_index -> pure-vocal wav path
            errors: dict[int, str] = {}
            peer_assignments = list(zip(accepted_peers, bounds[1:]))  # chunk 0 stays local

            def process_local_chunk():
                start, end = bounds[0]
                chunk_audio = str(work_dir / "chunk_0.wav")
                _cut_audio_chunk(audio_path, start, end, chunk_audio)
                if reporter:
                    reporter.update(25, "Обробляю свій кусок локально…")
                stems = separator_service.separate_file(chunk_audio, str(work_dir / "out_0"), model, ensemble, model_file=model_file, params=params)
                results[0] = stems["vocal_stem_path"]
                vocal_only_results[0] = stems.get("vocal_only_stem_path")

            def process_peer_chunk(idx: int, peer: dict, start: float, end: float):
                try:
                    chunk_audio = str(work_dir / f"chunk_{idx}.wav")
                    _cut_audio_chunk(audio_path, start, end, chunk_audio)
                    file_size = os.path.getsize(chunk_audio)
                    transfer_id = str(uuid.uuid4())
                    with open(chunk_audio, "rb") as fh:
                        discovery_service.upload_transfer(transfer_id, fh, file_size)
                    if reporter:
                        reporter.update(30, f"{peer['name']} обробляє свій кусок…")
                    power_logger.info("DISTRIBUTED-DISPATCH chunk=%s peer=%s title=%s", idx, peer["id"], title_name)
                    result = discovery_service.call_peer(peer["id"], {
                        "kind": "job_request", "task": "separate",
                        "transfer_id": transfer_id, "filename": os.path.basename(chunk_audio),
                        "model": model, "ensemble": bool(ensemble), "model_file": model_file, "params": params,
                        "requester_name": requester_name, "title_name": title_name, "episode_number": ep_number,
                    }, timeout=3600)
                    if result.get("kind") == "job_error" or not result.get("result_transfer_id"):
                        raise ValueError(result.get("reason", "невідома помилка"))
                    chunk_out = str(work_dir / f"peer_out_{idx}.wav")
                    discovery_service.download_transfer(result["result_transfer_id"], chunk_out)
                    discovery_service.delete_transfer(result["result_transfer_id"])
                    results[idx] = chunk_out

                    vocal_only_transfer_id = result.get("vocal_only_transfer_id")
                    if vocal_only_transfer_id:
                        chunk_vocal_only = str(work_dir / f"peer_vocal_only_{idx}.wav")
                        discovery_service.download_transfer(vocal_only_transfer_id, chunk_vocal_only)
                        discovery_service.delete_transfer(vocal_only_transfer_id)
                        vocal_only_results[idx] = chunk_vocal_only

                    power_logger.info("DISTRIBUTED-DONE chunk=%s peer=%s", idx, peer["id"])
                except Exception as exc:
                    power_logger.exception("DISTRIBUTED chunk=%s peer=%s failed, will redo locally", idx, peer["id"])
                    errors[idx] = str(exc)

            with ThreadPoolExecutor(max_workers=num_chunks) as pool:
                futures = [pool.submit(process_local_chunk)]
                for idx, (peer, (start, end)) in enumerate(peer_assignments, start=1):
                    futures.append(pool.submit(process_peer_chunk, idx, peer, start, end))
                for fut in as_completed(futures):
                    fut.result()  # re-raises if process_local_chunk itself blew up

            # --- Any peer chunk that failed gets redone locally, sequentially,
            # rather than reassigned to another peer — simpler and still correct,
            # just means this machine ends up doing more than its 1/N share. ---
            for idx, (peer, (start, end)) in enumerate(peer_assignments, start=1):
                if idx in errors:
                    if reporter:
                        reporter.update(70, f"{peer['name']} не впорався — переробляю кусок {idx} локально…")
                    chunk_audio = str(work_dir / f"chunk_{idx}.wav")
                    _cut_audio_chunk(audio_path, start, end, chunk_audio)
                    stems = separator_service.separate_file(chunk_audio, str(work_dir / f"out_{idx}"), model, ensemble, model_file=model_file, params=params)
                    results[idx] = stems["vocal_stem_path"]
                    vocal_only_results[idx] = stems.get("vocal_only_stem_path")

            # Only peers that actually delivered a usable chunk count as
            # having helped — one that failed and got silently redone
            # locally didn't really contribute, even though it was asked.
            report_ctx["peers_used"] = [
                peer["name"] for idx, (peer, _bounds) in enumerate(peer_assignments, start=1) if idx not in errors
            ]

            if reporter:
                reporter.update(85, "Склеюю результат…")

            ordered = [results[i] for i in range(num_chunks)]
            final_instrumental = str(output_dir / "vocal_isolated.wav")
            _crossfade_stitch(ordered, bounds, total_duration, OVERLAP_SECONDS, final_instrumental)

            final_vocal_only = None
            if all(vocal_only_results.get(i) for i in range(num_chunks)):
                ordered_vocal_only = [vocal_only_results[i] for i in range(num_chunks)]
                final_vocal_only = str(output_dir / "vocal_only.wav")
                _crossfade_stitch(ordered_vocal_only, bounds, total_duration, OVERLAP_SECONDS, final_vocal_only)

            ep.vocal_stem_path = final_instrumental
            ep.vocal_only_stem_path = final_vocal_only
            ep.status = "vocal_isolated"
            bump_title_in_progress(db, ep.title_id)
            db.commit()

            shutil.rmtree(work_dir, ignore_errors=True)

            if reporter:
                reporter.update(100, f"Готово — оброблено на {num_chunks} машинах")
            power_logger.info("DISTRIBUTED-COMPLETE episode=%s chunks=%s vocal_only=%s", episode_id, num_chunks, bool(final_vocal_only))
            return {"vocal_stem_path": final_instrumental, "vocal_only_stem_path": final_vocal_only, "chunks": num_chunks}
    finally:
        db.close()
