"""
Vocal separation via audio-separator (wraps Ultimate Vocal Remover's models).

Models exposed match UVR's own dropdown:
  - MDX-Net   → UVR-MDX-NET Inst HQ 3 (default — fast, low VRAM)
  - VR Arch   → UVR-DeEcho-Normal (VR Architecture)
  - Demucs    → htdemucs_ft (Demucs v4 fine-tuned)
  - MDX23C    → MDX23C-InstVoc HQ
  - BS-RoFormer → BS-Roformer-Viperx-1297 (best quality, slow/high VRAM)

Ensemble mode: run all selected models and average the stems, the way UVR's
own ensemble mode combines multiple model outputs.

NOTE: audio_separator.Separator.load_model() requires the *exact* filename
(including extension) from its model registry (Separator().list_supported_model_files()),
not the bare display name — verified 2026-07-19 against audio-separator 0.44.3.
"""
import math
import os
import shutil
import threading
import time
from pathlib import Path
from sqlalchemy.orm import Session

from ..models import Episode
from ..database import SessionLocal
from ..job_manager import ProgressReporter

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def _patch_separator_gpu_detection():
    """audio-separator's own Separator.setup_torch_device() gates ALL GPU
    acceleration — including for its ONNX-based models (MDX-Net) — behind
    torch.cuda.is_available(). torch here is deliberately the plain CPU build
    (see requirements.txt: a CUDA-enabled torch bundles a ~3.9GB private CUDA
    runtime that pushes the installer past GitHub Releases' 2GB per-file
    limit), so without this patch onnxruntime-gpu's CUDAExecutionProvider
    never gets used even though it's fully installed and working on its own
    (confirmed live 2026-07-19: onnxruntime reports CUDAExecutionProvider
    available, but audio-separator logged "No hardware acceleration could be
    configured" anyway because its check never even looks at onnxruntime's
    provider list unless torch.cuda.is_available() is already True).
    This replaces that one method to check onnxruntime's provider list
    independently: torch-based models (MDXC, Demucs, VR Arch) still run on
    CPU (no CUDA-enabled torch installed), but the ONNX-based MDX-Net model
    gets real CUDA acceleration via onnxruntime-gpu +
    nvidia-cublas-cu12/nvidia-cudnn-cu12."""
    try:
        from audio_separator.separator import Separator
        import torch
        import onnxruntime as ort
    except ImportError:
        return

    def _setup_torch_device(self, system_info):
        self.torch_device_cpu = torch.device("cpu")
        self.torch_device = self.torch_device_cpu
        if "CUDAExecutionProvider" in ort.get_available_providers():
            self.logger.info("ONNXruntime has CUDAExecutionProvider available, enabling acceleration for ONNX-based models")
            self.onnx_execution_provider = ["CUDAExecutionProvider"]
        else:
            self.logger.info("No hardware acceleration available for ONNX-based models, running in CPU mode")
            self.onnx_execution_provider = ["CPUExecutionProvider"]

    Separator.setup_torch_device = _setup_torch_device


_patch_separator_gpu_detection()

DEFAULT_MODEL = "MDX-Net"

MODEL_MAP = {
    "MDX-Net": "UVR-MDX-NET-Inst_HQ_3.onnx",
    "VR Arch": "UVR-De-Echo-Normal.pth",
    "Demucs": "htdemucs_ft.yaml",
    "MDX23C": "MDX23C-8KFFT-InstVoc_HQ.ckpt",
    "BS-RoFormer": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
}


def separate_file(
    audio_path: str,
    output_dir: str,
    model_name: str,
    ensemble: bool,
    on_progress=None,  # Optional[Callable[[int, str], None]] — no DB/job coupling
    is_cancelled=None,  # Optional[Callable[[], bool]]
) -> str:
    """Core separation routine, independent of any Episode/DB — used both for
    local jobs (run_separation below) and for power-shared jobs run on a peer
    machine that has no record of this episode at all."""
    try:
        from audio_separator.separator import Separator
    except ImportError:
        raise RuntimeError("audio-separator not installed. Run: pip install audio-separator")

    os.makedirs(output_dir, exist_ok=True)
    models_to_run = list(MODEL_MAP.keys()) if ensemble else [model_name]
    vocal_stems: list[str] = []

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    for idx, mdl in enumerate(models_to_run):
        if is_cancelled and is_cancelled():
            raise RuntimeError("Скасовано")

        uvr_model = MODEL_MAP.get(mdl, mdl)
        base_pct = int(idx / len(models_to_run) * 80)
        progress(base_pct + 5, f"нейромережа: завантаження моделі {mdl}…")

        sep = Separator(
            output_dir=output_dir,
            output_format="WAV",
            normalization_threshold=0.9,
            model_file_dir=str(Path(DATA_DIR) / "models"),
        )
        sep.load_model(uvr_model)

        progress(base_pct + 15, f"нейромережа: ізоляція вокалу ({mdl})…")

        # audio-separator has no progress callback API of its own (only tqdm
        # bars printed straight to stdout/stderr, not capturable cleanly) — so
        # a real multi-minute separation on a real (not a few seconds long)
        # episode would otherwise sit at one fixed percent the entire time,
        # which is indistinguishable from actually being frozen. Tick a
        # slowly-asymptoting estimate in the background so the number is
        # always visibly moving, without ever reaching the post-completion
        # value below (60s time constant: ~60% of the way there after a
        # minute, ~95% after three).
        heartbeat_stop = threading.Event()

        def _heartbeat(start_pct: int, cap_pct: int):
            t0 = time.monotonic()
            while not heartbeat_stop.wait(2):
                elapsed = time.monotonic() - t0
                frac = 1 - math.exp(-elapsed / 60)
                progress(int(start_pct + (cap_pct - start_pct) * frac), f"нейромережа: ізоляція вокалу ({mdl})…")

        hb_thread = threading.Thread(
            target=_heartbeat, args=(base_pct + 15, base_pct + int(80 / len(models_to_run)) - 2), daemon=True,
        )
        hb_thread.start()
        try:
            output_files = sep.separate(audio_path)
        finally:
            heartbeat_stop.set()
            hb_thread.join(timeout=3)
        # audio-separator returns bare filenames relative to output_dir, NOT
        # full/absolute paths — joining is required, otherwise os.path.isfile
        # below checks the process's CWD instead and silently "finds nothing"
        # even though the file was written correctly (confirmed via a direct
        # repro: separation succeeded and wrote both stems to output_dir, but
        # every returned name failed the bare isfile() check).
        output_paths = [
            f if os.path.isabs(f) else str(Path(output_dir) / f)
            for f in output_files
        ]

        # audio-separator names output files like: {stem}_(Vocals)_model.wav
        vocal_file = None
        for f in output_paths:
            if "Vocals" in f or "vocals" in f or "vocal" in f.lower():
                vocal_file = f
                break
        if not vocal_file and output_paths:
            vocal_file = output_paths[0]

        if vocal_file and os.path.isfile(vocal_file):
            vocal_stems.append(vocal_file)

        progress(base_pct + int(80 / len(models_to_run)), f"нейромережа: готово {mdl}")

    if not vocal_stems:
        raise RuntimeError("Не вдалося отримати вокальний стем")

    final_vocal = str(Path(output_dir) / "vocal_isolated.wav")
    if len(vocal_stems) == 1:
        shutil.copy2(vocal_stems[0], final_vocal)
    else:
        progress(85, "нейромережа: об'єднання стемів (ensemble)…")
        _average_stems(vocal_stems, final_vocal)

    progress(100, "нейромережа: вокал відокремлено")
    return final_vocal


def run_separation(
    episode_id: int,
    audio_path: str,
    model_name: str,
    ensemble: bool,
    reporter: ProgressReporter,
) -> dict:
    """Opens its own DB session rather than reusing the request's — this runs
    in a background thread pool that outlives the HTTP request, and a
    request-scoped Session gets closed by FastAPI's dependency teardown right
    after the endpoint returns, well before this actually finishes."""
    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep:
            raise ValueError(f"Episode {episode_id} not found")

        ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
        output_dir = ep_dir / "stems"

        final_vocal = separate_file(
            audio_path, str(output_dir), model_name, ensemble,
            on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
        )

        reporter.update(95, "Оновлення БД…")
        ep.vocal_stem_path = final_vocal
        ep.status = "vocal_isolated"
        db.commit()

        return {"vocal_stem_path": final_vocal}
    finally:
        db.close()


def _average_stems(stems: list[str], output_path: str):
    """Average multiple audio stems (ensemble mode)."""
    try:
        import numpy as np
        import soundfile as sf

        arrays = []
        sr = None
        for path in stems:
            data, s = sf.read(path, dtype="float32", always_2d=True)
            arrays.append(data)
            sr = s

        # Align lengths
        min_len = min(a.shape[0] for a in arrays)
        arrays = [a[:min_len] for a in arrays]

        averaged = np.mean(np.stack(arrays, axis=0), axis=0)
        sf.write(output_path, averaged, sr, subtype="PCM_24")
    except Exception as e:
        # Fallback: just copy first stem
        shutil.copy2(stems[0], output_path)
