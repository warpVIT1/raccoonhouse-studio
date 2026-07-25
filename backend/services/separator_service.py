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
import glob
import math
import os
import re
import shutil
import sys
import threading
import time
from pathlib import Path
from typing import Optional
from sqlalchemy.orm import Session

from ..models import Episode
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from .power_share_service import app_logger
from .title_status import bump_title_in_progress

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))


def _add_nvidia_dll_dirs():
    """onnxruntime-gpu's onnxruntime_providers_cuda.dll dynamically loads
    cudart64_12.dll, cublas64_12.dll, cudnn64_9.dll and cufft64_11.dll — it
    does NOT declare them as Python imports, so nothing puts them on the
    DLL search path by default. A CUDA-enabled torch normally does this
    itself at import time, but torch here is deliberately the plain CPU
    build (see requirements.txt), so the nvidia-*-cu12 pip packages that
    provide these DLLs are on their own.
    Without this, CUDAExecutionProvider creation fails with "LoadLibrary
    failed with error 126" and onnxruntime silently falls back to
    CPUExecutionProvider — logged only as a warning, easy to miss, and
    ort.get_available_providers() still lists CUDAExecutionProvider as
    "available" throughout (it only reflects what onnxruntime was built
    with, not whether the DLLs actually load) — confirmed live 2026-07-19
    that this is exactly what was happening: GPU idle, CPU pegged.
    os.add_dll_directory() does NOT fix this for onnxruntime's own loader
    (confirmed live); only prepending PATH does."""
    if getattr(sys, "frozen", False):
        bases = [os.path.join(sys._MEIPASS, "nvidia")]
    else:
        import importlib.util
        spec = importlib.util.find_spec("nvidia")
        bases = list(spec.submodule_search_locations) if spec and spec.submodule_search_locations else []

    dll_dirs = [d for base in bases for d in glob.glob(os.path.join(base, "*", "bin"))]
    if dll_dirs:
        os.environ["PATH"] = os.pathsep.join(dll_dirs) + os.pathsep + os.environ.get("PATH", "")


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
    independently, and (below) torch.cuda.is_available() directly — so the
    ONNX-based MDX-Net gets acceleration via onnxruntime-gpu regardless of
    torch's own CUDA status, and the torch-based models (VR Arch, Demucs,
    MDX23C, BS-RoFormer) get it too whenever the CUDA torch build has been
    swapped in (see gpu_runtime_service.py).

    GPU is opt-in via Settings (AppSettings.gpu_enabled, default False) — the
    CUDA runtime isn't bundled at all (see build-backend.py /
    gpu_runtime_service.py), so even checking onnxruntime's provider list is
    pointless until the user has actually opted in and the one-time download
    has run."""
    try:
        from audio_separator.separator import Separator
        import torch
    except ImportError:
        return

    def _setup_torch_device(self, system_info):
        self.torch_device_cpu = torch.device("cpu")
        self.torch_device = self.torch_device_cpu

        from ..models import AppSettings
        db = SessionLocal()
        try:
            row = db.get(AppSettings, 1)
            gpu_enabled = bool(row and row.gpu_enabled)
        finally:
            db.close()

        if not gpu_enabled:
            self.logger.info("GPU acceleration disabled in settings, running in CPU mode")
            self.onnx_execution_provider = ["CPUExecutionProvider"]
            return

        # torch's CUDA build gets swapped in via sys.path at process startup,
        # ahead of any import of torch anywhere (see backend/main.py and
        # gpu_runtime_service.py's torch_cuda_sys_path()) — if that swap
        # happened, torch.cuda.is_available() here already reflects it, so
        # the torch-based models (VR Arch, Demucs, MDX23C, BS-RoFormer) get
        # real GPU acceleration too, not just the ONNX-based MDX-Net below.
        if torch.cuda.is_available():
            self.logger.info("CUDA available in torch, enabling acceleration for torch-based models")
            self.torch_device = torch.device("cuda")

        if getattr(sys, "frozen", False):
            from .gpu_runtime_service import ensure_gpu_provider_placed
            ensure_gpu_provider_placed()
        else:
            _add_nvidia_dll_dirs()

        import onnxruntime as ort
        if "CUDAExecutionProvider" in ort.get_available_providers():
            self.logger.info("ONNXruntime has CUDAExecutionProvider available, enabling acceleration for ONNX-based models")
            self.onnx_execution_provider = ["CUDAExecutionProvider"]
        else:
            self.logger.info("No hardware acceleration available for ONNX-based models, running in CPU mode")
            self.onnx_execution_provider = ["CPUExecutionProvider"]

    Separator.setup_torch_device = _setup_torch_device


_patch_separator_gpu_detection()

DEFAULT_MODEL = "MDX-Net"

# Curated subset of audio-separator's full model registry (see
# Separator().list_supported_model_files() — hundreds of entries, mostly
# narrow community fine-tunes) for each method's dropdown in the Vocal
# Isolation window. First entry per method is that method's default
# (MODEL_MAP below). Filenames must match the registry exactly (checked
# live against audio-separator 0.44.3).
MODEL_CHOICES: dict[str, list[tuple[str, str]]] = {
    "MDX-Net": [
        ("UVR-MDX-NET Inst HQ 3", "UVR-MDX-NET-Inst_HQ_3.onnx"),
        ("UVR-MDX-NET Inst HQ 4", "UVR-MDX-NET-Inst_HQ_4.onnx"),
        ("UVR-MDX-NET Inst HQ 5", "UVR-MDX-NET-Inst_HQ_5.onnx"),
        ("UVR-MDX-NET Inst Main", "UVR-MDX-NET-Inst_Main.onnx"),
        ("UVR-MDX-NET Voc FT", "UVR-MDX-NET-Voc_FT.onnx"),
        ("Kim Vocal 2", "Kim_Vocal_2.onnx"),
        ("UVR-MDX-NET Karaoke 2", "UVR_MDXNET_KARA_2.onnx"),
        # Added from the UVR community tier list (Tier 1) — see
        # https://github.com/Anjok07/ultimatevocalremovergui's guide doc.
        ("Kim Inst", "Kim_Inst.onnx"),
        ("UVR-MDX-NET Inst 3", "UVR-MDX-NET-Inst_3.onnx"),
    ],
    "VR Arch": [
        ("UVR-De-Echo-Normal", "UVR-De-Echo-Normal.pth"),
        ("UVR-De-Echo-Aggressive", "UVR-De-Echo-Aggressive.pth"),
        ("UVR-DeEcho-DeReverb", "UVR-DeEcho-DeReverb.pth"),
        ("3_HP-Vocal-UVR", "3_HP-Vocal-UVR.pth"),
        ("4_HP-Vocal-UVR", "4_HP-Vocal-UVR.pth"),
        ("UVR-DeNoise", "UVR-DeNoise.pth"),
    ],
    "Demucs": [
        ("htdemucs_ft", "htdemucs_ft.yaml"),
        ("htdemucs", "htdemucs.yaml"),
        ("hdemucs_mmi", "hdemucs_mmi.yaml"),
        ("htdemucs_6s", "htdemucs_6s.yaml"),
    ],
    "MDX23C": [
        ("MDX23C-InstVoc HQ", "MDX23C-8KFFT-InstVoc_HQ.ckpt"),
        ("MDX23C-InstVoc HQ 2", "MDX23C-8KFFT-InstVoc_HQ_2.ckpt"),
        ("MDX23C De-Reverb", "MDX23C-De-Reverb-aufr33-jarredou.ckpt"),
        # Tier 1 in the UVR community guide's model tier list.
        ("MDX23C D1581", "MDX23C_D1581.ckpt"),
    ],
    "BS-RoFormer": [
        ("BS-Roformer-Viperx-1297", "model_bs_roformer_ep_317_sdr_12.9755.ckpt"),
        ("BS-Roformer-Viperx-1296", "model_bs_roformer_ep_368_sdr_12.9628.ckpt"),
        ("Mel-Roformer-Viperx-1143", "model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt"),
        ("MelBand Roformer Kim FT 3 (unwa)", "mel_band_roformer_kim_ft3_unwa.ckpt"),
        ("MelBand Roformer Vocals (becruily)", "mel_band_roformer_vocals_becruily.ckpt"),
        ("MelBand Roformer Instrumental (GaBOXR67)", "mel_band_roformer_instrumental_gabox.ckpt"),
    ],
}

MODEL_MAP = {method: choices[0][1] for method, choices in MODEL_CHOICES.items()}

# Which of audio-separator's Separator(...) per-architecture kwargs
# (mdx_params / vr_params / demucs_params / mdxc_params) applies to each
# model — MDX23C and BS-RoFormer are both "mdxc" architecture models (.ckpt),
# matching audio-separator's own internal classification.
MODEL_ARCH = {
    "MDX-Net": "mdx",
    "VR Arch": "vr",
    "Demucs": "demucs",
    "MDX23C": "mdxc",
    "BS-RoFormer": "mdxc",
}


def separate_file(
    audio_path: str,
    output_dir: str,
    model_name: str,
    ensemble: bool,
    model_file: Optional[str] = None,  # specific checkpoint filename — see MODEL_CHOICES; defaults to MODEL_MAP[model_name] if omitted
    params: Optional[dict] = None,  # {"mdx"|"vr"|"demucs"|"mdxc": {...}} — see MODEL_ARCH
    on_progress=None,  # Optional[Callable[[int, str], None]] — no DB/job coupling
    is_cancelled=None,  # Optional[Callable[[], bool]]
) -> str:
    """Core separation routine, independent of any Episode/DB — used both for
    local jobs (run_separation below) and for power-shared jobs run on a peer
    machine that has no record of this episode at all.

    `params`, if given, must be a COMPLETE per-architecture kwarg dict (every
    key Separator's own default for that *_params carries) — audio-separator's
    architecture classes read these via `arch_config.get("key")` with no
    fallback default of their own, so a partial dict silently turns any
    missing key into None instead of a sane value."""
    try:
        from audio_separator.separator import Separator
    except ImportError:
        app_logger.exception("separate_file: audio-separator not installed")
        raise RuntimeError("audio-separator not installed. Run: pip install audio-separator")

    app_logger.info(
        "separate_file: start audio_path=%s output_dir=%s model_name=%s ensemble=%s model_file=%s params=%s",
        audio_path, output_dir, model_name, ensemble, model_file, params,
    )
    if not os.path.isfile(audio_path):
        app_logger.error("separate_file: audio_path does not exist: %s", audio_path)

    os.makedirs(output_dir, exist_ok=True)
    models_to_run = list(MODEL_MAP.keys()) if ensemble else [model_name]
    vocal_stems: list[str] = []
    instrumental_stems: list[str] = []

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    for idx, mdl in enumerate(models_to_run):
        if is_cancelled and is_cancelled():
            raise RuntimeError("Скасовано")

        # A specific-checkpoint override only applies to a single selected
        # method, not ensemble mode (which always runs each method's own
        # default checkpoint — there's no single "the" model_file to apply
        # across 5 different architectures at once).
        uvr_model = model_file if (model_file and not ensemble) else MODEL_MAP.get(mdl, mdl)
        base_pct = int(idx / len(models_to_run) * 80)
        progress(base_pct + 5, f"нейромережа: завантаження моделі {mdl}…")

        sep_kwargs = dict(
            output_dir=output_dir,
            output_format="WAV",
            normalization_threshold=0.9,
            model_file_dir=str(Path(DATA_DIR) / "models"),
        )
        arch = MODEL_ARCH.get(mdl)
        if params and arch and params.get(arch):
            sep_kwargs[f"{arch}_params"] = params[arch]
        app_logger.info("separate_file: loading model %s (arch=%s, file=%s)", mdl, arch, uvr_model)
        try:
            sep = Separator(**sep_kwargs)
            sep.load_model(uvr_model)
        except Exception:
            app_logger.exception("separate_file: failed to load model %s (file=%s)", mdl, uvr_model)
            raise

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
        except Exception:
            app_logger.exception("separate_file: sep.separate() failed for model %s", mdl)
            raise
        finally:
            heartbeat_stop.set()
            hb_thread.join(timeout=3)
        app_logger.info("separate_file: model %s produced output files: %s", mdl, output_files)
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

        # audio-separator names output files like: {stem}_(Vocals)_model.wav /
        # {stem}_(Instrumental)_model.wav. Match by name for both; whichever
        # output isn't the matched vocal file is assumed to be the
        # instrumental counterpart if no name match is found (covers models
        # with unfamiliar naming, as long as they still produce exactly a
        # vocal/non-vocal pair — not guaranteed for 4-stem architectures like
        # Demucs, but that's an existing ensemble-mode rough edge, not
        # something this fixes).
        vocal_file = None
        instrumental_file = None
        for f in output_paths:
            if "vocal" in f.lower():
                vocal_file = f
                break
        for f in output_paths:
            if "instrumental" in f.lower():
                instrumental_file = f
                break
        if not vocal_file and output_paths:
            vocal_file = output_paths[0]
        if not instrumental_file:
            remaining = [f for f in output_paths if f != vocal_file]
            instrumental_file = remaining[0] if remaining else None

        if vocal_file and os.path.isfile(vocal_file):
            vocal_stems.append(vocal_file)
        if instrumental_file and os.path.isfile(instrumental_file):
            instrumental_stems.append(instrumental_file)

        progress(base_pct + int(80 / len(models_to_run)), f"нейромережа: готово {mdl}")

    if not instrumental_stems:
        app_logger.error(
            "separate_file: no instrumental stems produced (vocal_stems=%s, instrumental_stems=%s)",
            vocal_stems, instrumental_stems,
        )
        raise RuntimeError("Не вдалося отримати інструментальний стем")

    # The instrumental (original vocal removed) is the actual deliverable —
    # dubbing needs a clean base to lay new voice over, not the isolated
    # voice itself. The pure-vocal stem is kept separately only because
    # VAD-based marker detection needs an actual voice signal to find speech
    # gaps in — it has no use for the instrumental.
    final_instrumental = str(Path(output_dir) / "vocal_isolated.wav")
    if len(instrumental_stems) == 1:
        shutil.copy2(instrumental_stems[0], final_instrumental)
    else:
        progress(85, "нейромережа: об'єднання стемів (ensemble)…")
        _average_stems(instrumental_stems, final_instrumental)

    final_vocal_only = None
    if vocal_stems:
        final_vocal_only = str(Path(output_dir) / "vocal_only.wav")
        if len(vocal_stems) == 1:
            shutil.copy2(vocal_stems[0], final_vocal_only)
        else:
            _average_stems(vocal_stems, final_vocal_only)

    progress(100, "нейромережа: вокал відокремлено")
    return {"vocal_stem_path": final_instrumental, "vocal_only_stem_path": final_vocal_only}


def run_separation(
    episode_id: int,
    audio_path: str,
    model_name: str,
    ensemble: bool,
    reporter: ProgressReporter,
    model_file: Optional[str] = None,
    params: Optional[dict] = None,
) -> dict:
    """Opens its own DB session rather than reusing the request's — this runs
    in a background thread pool that outlives the HTTP request, and a
    request-scoped Session gets closed by FastAPI's dependency teardown right
    after the endpoint returns, well before this actually finishes."""
    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep:
            app_logger.error("run_separation: episode %s not found", episode_id)
            raise ValueError(f"Episode {episode_id} not found")

        ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
        output_dir = ep_dir / "stems"

        try:
            stems = separate_file(
                audio_path, str(output_dir), model_name, ensemble, model_file=model_file, params=params,
                on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
            )
        except Exception:
            app_logger.exception("run_separation: separate_file failed for episode %s", episode_id)
            raise

        reporter.update(95, "Оновлення БД…")
        ep.vocal_stem_path = stems["vocal_stem_path"]
        ep.vocal_only_stem_path = stems["vocal_only_stem_path"]
        ep.status = "vocal_isolated"
        bump_title_in_progress(db, ep.title_id)
        db.commit()
        app_logger.info("run_separation: episode %s done, stems=%s", episode_id, stems)

        return stems
    finally:
        db.close()


def separate_file_batch(
    audio_path: str,
    output_dir: str,
    on_progress=None,  # Optional[Callable[[int, str], None]]
    is_cancelled=None,  # Optional[Callable[[], bool]]
) -> dict[str, str]:
    """Runs every model in MODEL_MAP (the same set Ensemble Mode uses) but,
    unlike Ensemble Mode, keeps each model's own instrumental as a SEPARATE
    file instead of averaging them into one blended result — for comparing
    models side by side or rendering with whichever one turns out best
    per-episode, rather than committing to a single averaged guess. Only the
    instrumental is kept (not the isolated-vocal counterpart) — this mode is
    for picking/comparing a final instrumental track, which is the only
    thing dubbing actually needs; FLAC, not WAV, to keep 5x the usual output
    size down to something reasonable while staying lossless.

    Returns {model_name: instrumental_flac_path} — deliberately does not
    touch any Episode column (there's no single "the" result to promote the
    way normal/ensemble separation has), so the episode's status and
    vocal_stem_path are left exactly as they were before this ran."""
    try:
        from audio_separator.separator import Separator
    except ImportError:
        app_logger.exception("separate_file_batch: audio-separator not installed")
        raise RuntimeError("audio-separator not installed. Run: pip install audio-separator")

    app_logger.info("separate_file_batch: start audio_path=%s output_dir=%s", audio_path, output_dir)
    os.makedirs(output_dir, exist_ok=True)
    models_to_run = list(MODEL_MAP.keys())
    results: dict[str, str] = {}

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    for idx, mdl in enumerate(models_to_run):
        if is_cancelled and is_cancelled():
            raise RuntimeError("Скасовано")

        uvr_model = MODEL_MAP[mdl]
        base_pct = int(idx / len(models_to_run) * 90)
        progress(base_pct + 2, f"нейромережа: завантаження моделі {mdl}…")

        sep = Separator(
            output_dir=output_dir,
            output_format="FLAC",
            normalization_threshold=0.9,
            model_file_dir=str(Path(DATA_DIR) / "models"),
        )
        try:
            sep.load_model(uvr_model)
        except Exception:
            app_logger.exception("separate_file_batch: failed to load model %s (file=%s)", mdl, uvr_model)
            raise

        progress(base_pct + int(90 / len(models_to_run) / 2), f"нейромережа: ізоляція вокалу ({mdl})…")
        try:
            output_files = sep.separate(audio_path)
        except Exception:
            app_logger.exception("separate_file_batch: sep.separate() failed for model %s", mdl)
            raise
        output_paths = [
            f if os.path.isabs(f) else str(Path(output_dir) / f)
            for f in output_files
        ]

        # Only the instrumental is kept for batch mode (see docstring) — no
        # need to even locate the vocal-only counterpart.
        instrumental_file = next((f for f in output_paths if "instrumental" in f.lower()), None)
        if not instrumental_file and output_paths:
            instrumental_file = output_paths[0]

        safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", mdl)
        if instrumental_file and os.path.isfile(instrumental_file):
            final_instrumental = str(Path(output_dir) / f"{safe_name}_instrumental.flac")
            shutil.copy2(instrumental_file, final_instrumental)
            results[mdl] = final_instrumental
        # Every intermediate file audio-separator wrote for this model
        # (including whichever one WASN'T the instrumental — the isolated
        # vocal stem this mode doesn't keep) is no longer needed once its
        # renamed copy exists — without cleanup, output_dir would keep every
        # model's raw output on top of the renamed copies.
        for f in output_paths:
            if f != instrumental_file and os.path.isfile(f):
                os.remove(f)

        progress(base_pct + int(90 / len(models_to_run)), f"нейромережа: готово {mdl}")

    progress(100, "нейромережа: всі моделі оброблено")
    app_logger.info("separate_file_batch: done, results=%s", results)
    return results


def run_batch_separation(
    episode_id: int,
    audio_path: str,
    reporter: ProgressReporter,
    output_dir: Optional[str] = None,  # user-picked via the native folder dialog; falls back to the episode's own data-dir folder if omitted
) -> dict:
    """Opens its own DB session — see run_separation's docstring for why."""
    db = SessionLocal()
    try:
        ep = db.get(Episode, episode_id)
        if not ep:
            app_logger.error("run_batch_separation: episode %s not found", episode_id)
            raise ValueError(f"Episode {episode_id} not found")

        if output_dir:
            output_dir = Path(output_dir)
        else:
            ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
            output_dir = ep_dir / "stems" / "batch"

        try:
            results = separate_file_batch(
                audio_path, str(output_dir),
                on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
            )
        except Exception:
            app_logger.exception("run_batch_separation: failed for episode %s", episode_id)
            raise

        app_logger.info("run_batch_separation: episode %s done, output_dir=%s", episode_id, output_dir)
        return {"output_dir": str(output_dir), "models": results}
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
