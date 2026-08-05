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
import contextlib
import glob
import json
import logging
import math
import os
import re
import shutil
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional
from sqlalchemy.orm import Session

from ..models import AppSettings, Episode, Profile, Title
from ..database import SessionLocal
from ..job_manager import ProgressReporter
from .power_share_service import app_logger
from .title_status import bump_title_in_progress

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))

_INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def _sanitize_filename(name: str) -> str:
    """Strips characters Windows forbids in file/folder names while keeping
    everything else — including Cyrillic/Ukrainian title names — intact.
    Deliberately NOT the old batch-mode approach of an ASCII-only regex,
    which would have mangled any non-Latin title into a string of
    underscores."""
    cleaned = _INVALID_FILENAME_CHARS.sub("_", name).strip().rstrip(".")
    return cleaned or "untitled"


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


_gpu_detection_patch_applied = False


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
    has run.

    Lazy and idempotent — patches the class method once, on first actual
    use, rather than at module import time. This used to run unconditionally
    at module scope (right after this function's definition), which meant
    every backend startup ate torch/audio-separator/scipy's full import cost
    (~28s, confirmed live via `python -X importtime`) before uvicorn could
    even bind the port — the app looked hung on "loading profiles" because
    nothing (WS connect, /profiles, anything) could happen until that import
    chain finished, regardless of whether a separation job was ever run.
    Callers must call this once before instantiating Separator(), same as
    they already do for the plain `from audio_separator.separator import
    Separator` lazy-import right above each of those call sites."""
    global _gpu_detection_patch_applied
    if _gpu_detection_patch_applied:
        return
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
        else:
            # Silent before this — GPU setting on, sys.path swapped to the
            # CUDA torch build, yet is_available() still False with no clue
            # why (torch swallows its own CUDA-init errors and just returns
            # False). Confirmed live: torch-based models (BS-RoFormer/VR
            # Arch/Demucs/MDX23C) silently ran on CPU for an entire session
            # while ONNX-based ones (MDX-Net) still got CUDA fine, with
            # nothing in any log explaining the mismatch.
            from .gpu_runtime_service import is_torch_cuda_installed
            self.logger.warning(
                "GPU enabled in settings but torch.cuda.is_available() is False "
                "(torch_cuda_installed=%s) — torch-based models will run on CPU this session",
                is_torch_cuda_installed(),
            )

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
    _gpu_detection_patch_applied = True


_ARCH_TO_UVR_MODEL_TYPE = {"mdx": "MDX", "vr": "VR", "demucs": "Demucs", "mdxc": "MDXC"}
_custom_loading_patch_applied = False


def _downloaded_custom_model(filename: str) -> "dict | None":
    from ..models import DownloadedCustomModel
    db = SessionLocal()
    try:
        row = db.query(DownloadedCustomModel).filter_by(filename=filename).first()
        if not row:
            return None
        return {"label": row.label, "arch": row.arch, "config_yaml_filename": row.config_yaml_filename}
    finally:
        db.close()


def _patch_custom_model_loading():
    """audio-separator's own Separator.download_model_files() only ever
    recognizes a filename already present in ITS OWN built-in registry — for
    anything else (a Model Browser catalog entry added via the "add by URL"
    flow, see routers/model_browser.py) it raises ValueError immediately,
    even when the file is already sitting on disk in model_file_dir (see
    that method's source: the registry search happens before any disk
    check). This wraps it: if the requested filename matches a model this
    install has actually downloaded via the browser (DownloadedCustomModel),
    resolve it directly from local metadata instead of falling through to
    the registry lookup. Falls through to the original method for
    everything else, so built-in registry models keep working exactly as
    before. Idempotent/lazy, same reasoning as _patch_separator_gpu_detection
    above — no eager import-time cost."""
    global _custom_loading_patch_applied
    if _custom_loading_patch_applied:
        return
    try:
        from audio_separator.separator import Separator
    except ImportError:
        return

    _original_download_model_files = Separator.download_model_files

    def _patched_download_model_files(self, model_filename):
        custom = _downloaded_custom_model(model_filename)
        if custom is not None:
            model_path = os.path.join(self.model_file_dir, model_filename)
            if os.path.isfile(model_path):
                yaml_config_filename = custom["config_yaml_filename"]
                if yaml_config_filename and not os.path.isfile(os.path.join(self.model_file_dir, yaml_config_filename)):
                    yaml_config_filename = None
                model_type = _ARCH_TO_UVR_MODEL_TYPE.get(custom["arch"], "MDXC")
                return model_filename, model_type, custom["label"], model_path, yaml_config_filename
        return _original_download_model_files(self, model_filename)

    Separator.download_model_files = _patched_download_model_files
    _custom_loading_patch_applied = True


def _ensure_separator_patches():
    """Both patches above must be applied before any Separator() is used for
    a real separation — bundled into one call so every call site (see the
    4 `from audio_separator.separator import Separator` usage sites below)
    only needs to remember one name."""
    _patch_separator_gpu_detection()
    _patch_custom_model_loading()


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
    # UVR-De-Echo-Normal/Aggressive, UVR-DeEcho-DeReverb, and UVR-DeNoise were
    # removed 2026-07-26 — they aren't vocal/instrumental separators at all,
    # they're post-processing cleanup tools (confirmed live: the "VR Arch"
    # default, UVR-De-Echo-Normal, produces stems literally named "No Echo"/
    # "Echo", not "Vocals"/"Instrumental" — neither one is vocal-removed, so
    # the render came out as the full mix with vocals still in it, not an
    # instrumental). Only 3_HP-Vocal-UVR and 4_HP-Vocal-UVR are genuine
    # UVR-Architecture vocal/instrumental separation models.
    "VR Arch": [
        ("3_HP-Vocal-UVR", "3_HP-Vocal-UVR.pth"),
        ("4_HP-Vocal-UVR", "4_HP-Vocal-UVR.pth"),
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
    # "MelBand Roformer Instrumental (GaBOXR67)" (mel_band_roformer_instrumental_gabox.ckpt)
    # was removed 2026-07-31 — confirmed live in production use that its two
    # output stems come out swapped (the file this app picks as "instrumental"
    # by filename match is actually the vocal-only content, and vice versa).
    # audio-separator's own registry has zero stem metadata for this specific
    # entry (stems=[], target_stem=None — unlike the well-documented Viperx/
    # becruily models above), so the earlier registry-based validation added
    # for custom models (see check_registry_model) has nothing to check this
    # one against; it was only caught by a real user hitting the wrong output
    # in practice, the same way the old VR Arch defaults were.
    "BS-RoFormer": [
        ("BS-Roformer-Viperx-1297", "model_bs_roformer_ep_317_sdr_12.9755.ckpt"),
        ("BS-Roformer-Viperx-1296", "model_bs_roformer_ep_368_sdr_12.9628.ckpt"),
        ("Mel-Roformer-Viperx-1143", "model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt"),
        ("MelBand Roformer Kim FT 3 (unwa)", "mel_band_roformer_kim_ft3_unwa.ckpt"),
        ("MelBand Roformer Vocals (becruily)", "mel_band_roformer_vocals_becruily.ckpt"),
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

# "Апекс" — a 6th, ensemble-only pseudo-method alongside the 5 above (no
# checkpoint dropdown of its own: it always runs this exact hand-picked set
# and averages them, the same way Ensemble Mode below averages its own set).
# Unlike Ensemble Mode's "one default per broad method" (which includes VR
# Arch/Demucs — older, bleedier architectures per the UVR/MVSEP community's
# own architecture comparisons), this is a cross-architecture pick of
# specifically the strongest verified models already in MODEL_CHOICES:
# BS-Roformer's Viperx pair (praised in community writeups for NOT
# misclassifying orchestral/ethnic instruments as vocals — relevant for
# anime OSTs), MDX23C-InstVoc HQ and Kim Vocal 2 for architecture diversity
# (the community's own advice is that cross-architecture ensembles reduce
# redundant artifacts better than averaging near-identical model families),
# and MelBand Roformer Kim FT 3 to round it out. Each tuple is
# (display label, exact registry filename, architecture kwarg key).
#
# This is only the SEED/fallback list — the actual line-up used at runtime
# lives in the ApexModel DB table (see _load_apex_models below) so it can be
# edited live from Settings, no rebuild+redeploy needed. Rename this if you
# ever need to change the seed itself; existing installs that already seeded
# their DB table won't be affected either way.
APEX_METHOD = "Апекс"
APEX_MODELS_DEFAULT: list[tuple[str, str, str]] = [
    ("BS-Roformer-Viperx-1297", "model_bs_roformer_ep_317_sdr_12.9755.ckpt", "mdxc"),
    ("BS-Roformer-Viperx-1296", "model_bs_roformer_ep_368_sdr_12.9628.ckpt", "mdxc"),
    ("MDX23C-InstVoc HQ", "MDX23C-8KFFT-InstVoc_HQ.ckpt", "mdxc"),
    ("Kim Vocal 2", "Kim_Vocal_2.onnx", "mdx"),
    ("MelBand Roformer Kim FT 3 (unwa)", "mel_band_roformer_kim_ft3_unwa.ckpt", "mdxc"),
]


PERSONAL_ENSEMBLE_METHOD = "МійАнсамбль"


def _load_personal_ensemble_models(profile_id: Optional[int]) -> list[tuple[str, str, str]]:
    """Reads ONE profile's own "Мій ансамбль" line-up — unlike Апекс, never
    seeded with a default: an empty result here means this profile hasn't
    picked anything yet (see routers/separation_models.py, which the frontend
    surfaces as "add models to run this")."""
    if not profile_id:
        return []
    from ..database import SessionLocal
    from ..models import PersonalEnsembleModel

    db = SessionLocal()
    try:
        rows = (
            db.query(PersonalEnsembleModel)
            .filter_by(profile_id=profile_id)
            .order_by(PersonalEnsembleModel.id)
            .all()
        )
        return [(r.label, r.filename, r.arch) for r in rows]
    finally:
        db.close()


def _load_apex_models() -> list[tuple[str, str, str]]:
    """Reads Апекс's current line-up from the DB, seeding it from
    APEX_MODELS_DEFAULT on first use if the table is still empty. A short-
    lived session opened here directly (not threaded through as a parameter)
    — same pattern _patch_separator_gpu_detection's _setup_torch_device
    already uses in this file to read AppSettings.gpu_enabled — keeps
    separate_file()'s own signature/callers (local, distributed, peer) fully
    unchanged."""
    from ..database import SessionLocal
    from ..models import ApexModel

    db = SessionLocal()
    try:
        rows = db.query(ApexModel).order_by(ApexModel.id).all()
        if not rows:
            for label, filename, arch in APEX_MODELS_DEFAULT:
                db.add(ApexModel(method=_arch_to_method(arch, filename), label=label, filename=filename, arch=arch))
            db.commit()
            rows = db.query(ApexModel).order_by(ApexModel.id).all()
        return [(r.label, r.filename, r.arch) for r in rows]
    finally:
        db.close()


def _arch_to_method(arch: str, filename: str) -> str:
    """Best-effort reverse lookup for seeding only — ApexModel.method is
    informational (shown in the Апекс editor UI), the actual job only ever
    needs arch/filename. MDXC covers both MDX23C and BS-RoFormer, so the
    filename's own naming convention picks between them for display."""
    if arch == "mdx":
        return "MDX-Net"
    if arch == "vr":
        return "VR Arch"
    if arch == "demucs":
        return "Demucs"
    return "MDX23C" if filename.lower().startswith("mdx23c") else "BS-RoFormer"


def sync_apex_models_from_remote(db, remote: list[dict]) -> None:
    """Replaces the local ApexModel table with whatever the Worker's
    canonical copy says, so every install converges on the line-up whoever's
    admin last pushed (see routers/separation_models.py's push after each
    add/remove). Matched by filename (the thing that actually determines
    behavior — label/method are just display). Called opportunistically
    only — e.g. whenever a client's own Апекс panel is opened (see
    GET /api/models/apex) — never from _load_apex_models itself, so a
    network hiccup mid-separation can't block or alter an in-progress job."""
    from ..models import ApexModel

    existing = {row.filename: row for row in db.query(ApexModel).all()}
    remote_filenames = {r["filename"] for r in remote if r.get("filename")}
    for filename, row in existing.items():
        if filename not in remote_filenames:
            db.delete(row)
    for r in remote:
        filename = r.get("filename")
        if filename and filename not in existing:
            db.add(ApexModel(
                method=r.get("method") or _arch_to_method(r.get("arch", "mdxc"), filename),
                label=r.get("label") or filename,
                filename=filename,
                arch=r.get("arch") or "mdxc",
            ))
    db.commit()


def push_apex_models_to_worker(db) -> None:
    """Called after the admin's add/remove commits locally (see
    routers/separation_models.py) — pushes the FULL current line-up as one
    replacement, not an incremental diff, since the Worker only ever stores
    one shared blob (see cloudflare-signaling's /apex-models). Best-effort,
    matching every other cross-machine sync in this app's trust model."""
    from ..models import ApexModel
    from . import discovery_service

    rows = db.query(ApexModel).order_by(ApexModel.id).all()
    lineup = [{"method": r.method, "label": r.label, "filename": r.filename, "arch": r.arch} for r in rows]
    discovery_service.push_apex_models(lineup)


# Апекс's line-up gets averaged (see _average_stems) — which dilutes residual
# vocal bleed without necessarily eliminating it: if even one model in the
# line-up left some vocal audible, the average still carries a fraction of
# it, which sounds "muffled" rather than "gone" (confirmed live 2026-08-02 —
# exactly the complaint that prompted this). Running the already-averaged
# instrumental through one more strong single-model pass only has to remove
# whatever's left (a much weaker signal than the original full mix, since
# the average already did most of the work), so it reliably finishes what
# ensemble-averaging alone can't guarantee — the same "double pass" idea the
# UVR/MVSEP community itself uses for stubborn residual bleed.
APEX_CLEANUP_MODEL: tuple[str, str, str] = (
    "BS-Roformer-Viperx-1297", "model_bs_roformer_ep_317_sdr_12.9755.ckpt", "mdxc",
)


# Overlap maxed out by default (audio-separator's own default is 8, UI
# slider tops out at 16) — this pass only has to clean up whatever residual
# bleed survived averaging, not do the primary separation, so the extra
# thoroughness (slower, more overlapping windows processed) is worth it:
# confirmed live 2026-08-02 that the default overlap still left a few quiet
# words audible. Overridable from the UI's "Розширені налаштування" for
# Апекс (see VocalSeparationModal.tsx's buildParams) — this is only the
# fallback when the caller didn't send one.
_APEX_CLEANUP_DEFAULT_PARAMS = {
    "segment_size": 256, "override_model_segment_size": False, "batch_size": 1, "overlap": 16, "pitch_shift": 0,
}


def _apex_cleanup_pass(instrumental_path: str, output_dir: str, progress, mdxc_params: Optional[dict] = None) -> None:
    """Runs APEX_CLEANUP_MODEL on Апекс's already-averaged instrumental and
    overwrites it in place with the result. Mutates instrumental_path on
    disk rather than returning a new path — callers already treat that path
    as the final Апекс deliverable."""
    from audio_separator.separator import Separator
    _ensure_separator_patches()

    label, filename, _arch = APEX_CLEANUP_MODEL
    progress(90, f"нейромережа: другий прохід для повного видалення вокалу ({label})…")
    sep = Separator(
        output_dir=output_dir,
        output_format="WAV",
        normalization_threshold=0.9,
        model_file_dir=str(Path(DATA_DIR) / "models"),
        mdxc_params=mdxc_params or _APEX_CLEANUP_DEFAULT_PARAMS,
    )
    try:
        sep.load_model(filename)
        output_files = sep.separate(instrumental_path)
    except Exception:
        app_logger.exception("_apex_cleanup_pass: second pass failed, keeping the averaged instrumental as-is")
        return

    output_paths = [f if os.path.isabs(f) else str(Path(output_dir) / f) for f in output_files]
    cleaned = next((f for f in output_paths if "instrumental" in f.lower()), None)
    if not cleaned and output_paths:
        cleaned = output_paths[0]
    if cleaned and os.path.isfile(cleaned):
        shutil.copy2(cleaned, instrumental_path)
    # This pass's own raw output files (both the copied-from one and its
    # vocal counterpart) are never kept — same reasoning as
    # separate_file_batch's per-model cleanup: audio-separator's intermediate
    # filenames would otherwise just accumulate on every Апекс run.
    for f in output_paths:
        if os.path.isfile(f):
            os.remove(f)
    progress(97, "нейромережа: другий прохід завершено")


_DIP_WINDOW_SECONDS = 0.5
_DIP_TREND_SECONDS = 6.0
_DIP_MAX_BOOST_DB = 9.0


def _rms_windows(mono, n_windows: int, window: int, hop: int) -> "object":
    import numpy as np
    rms = np.empty(n_windows, dtype=np.float64)
    for i in range(n_windows):
        seg = mono[i * hop:i * hop + window]
        rms[i] = np.sqrt(np.mean(seg.astype(np.float64) ** 2)) if len(seg) else 0.0
    return rms


def _smooth_gain(gain, alpha: float = 0.2) -> None:
    """Two-pass exponential moving average, in place — makes a correction
    curve fade in/out instead of stepping between windows, so the fix
    doesn't create a new, self-inflicted pumping artifact of its own."""
    for i in range(1, len(gain)):
        gain[i] = alpha * gain[i] + (1 - alpha) * gain[i - 1]
    for i in range(len(gain) - 2, -1, -1):
        gain[i] = alpha * gain[i] + (1 - alpha) * gain[i + 1]


def _match_length(arr, n: int):
    import numpy as np
    if len(arr) >= n:
        return arr[:n]
    return np.pad(arr, (0, n - len(arr)))


_LEAK_WINDOW_SECONDS = 0.5
_LEAK_CORR_THRESHOLD = 0.4
_LEAK_MAX_REDUCTION_DB = 18.0


def _suppress_leaks(instrumental_path: str, vocal_only_path: str) -> None:
    """Final safety net for Апекс, after _apex_cleanup_pass + _level_dips —
    a cheap, model-free "quick check" that directly compares the finished
    instrumental against the isolated vocal stem (the one signal that
    confirms for certain where a vocal actually was) and suppresses any
    window that still correlates with it. This is exactly the manual
    diagnostic that found a real leak at 3:38 in a live test (2026-08-02:
    normalized correlation ~0.85 between the "clean" instrumental and the
    vocal stem at that timestamp, versus ~0-0.3 everywhere genuinely clean),
    now automated and always applied rather than run by hand after the fact.

    Deliberately MORE sensitive than the main line-up and the cleanup pass —
    per the user's own request: "level 1 sensitivity on the main pass, a bit
    better on the check, because it needs to hear what the main one didn't."
    It only ever has to catch what survived two prior passes, so a lower bar
    for "this still sounds like the vocal" is the right call specifically
    here, where a false positive just costs a little extra attenuation on an
    already-processed track rather than damaging a first-pass separation."""
    import numpy as np
    import soundfile as sf

    inst, sr = sf.read(instrumental_path, dtype="float32", always_2d=True)
    voc, _sr2 = sf.read(vocal_only_path, dtype="float32", always_2d=True)
    n = min(inst.shape[0], voc.shape[0])
    if n == 0:
        return
    inst_m = inst[:n].mean(axis=1).astype(np.float64)
    voc_m = voc[:n].mean(axis=1).astype(np.float64)

    window = max(1, int(_LEAK_WINDOW_SECONDS * sr))
    hop = max(1, window // 2)
    n_windows = max(1, (n - 1) // hop + 1)
    centers = np.array([i * hop + min(window, n - i * hop) // 2 for i in range(n_windows)])

    # Floors relative to each track's own overall level, not an absolute
    # number — a fixed threshold reads as spuriously "perfectly correlated"
    # in near-silent windows, where both signals are essentially noise
    # (confirmed live 2026-08-02 while hand-diagnosing the 3:38 leak: an
    # absolute floor of 0.003 still let near-silent windows through with
    # correlation == 1.000, a numerical artifact, not a real leak).
    voc_rms_all = float(np.sqrt(np.mean(voc_m ** 2))) or 1e-9
    inst_rms_all = float(np.sqrt(np.mean(inst_m ** 2))) or 1e-9
    voc_floor = voc_rms_all * 0.5
    inst_floor = inst_rms_all * 0.3

    max_reduction = 10 ** (-_LEAK_MAX_REDUCTION_DB / 20)
    gain = np.ones(n_windows, dtype=np.float64)
    for i in range(n_windows):
        s0 = i * hop
        a = inst_m[s0:s0 + window]
        b = voc_m[s0:s0 + window]
        if len(a) < 2 or len(b) < 2:
            continue
        if np.sqrt(np.mean(b ** 2)) < voc_floor or np.sqrt(np.mean(a ** 2)) < inst_floor:
            continue  # not enough signal in either track for a meaningful comparison
        a_n, b_n = a - a.mean(), b - b.mean()
        denom = np.linalg.norm(a_n) * np.linalg.norm(b_n)
        corr = float(np.dot(a_n, b_n) / denom) if denom > 1e-9 else 0.0
        if corr > _LEAK_CORR_THRESHOLD:
            # Scale the reduction with how strongly it correlates — a
            # borderline 0.4 gets a light touch, a blatant 0.85+ gets pulled
            # down hard, rather than every flagged window getting the same
            # fixed cut regardless of how obvious the leak actually is.
            strength = min(1.0, (corr - _LEAK_CORR_THRESHOLD) / (1.0 - _LEAK_CORR_THRESHOLD))
            gain[i] = 1.0 - strength * (1.0 - max_reduction)

    _smooth_gain(gain)

    sample_gain = np.interp(np.arange(n), centers, gain).astype(np.float32)
    inst[:n] *= sample_gain[:, None]
    np.clip(inst, -1.0, 1.0, out=inst)
    sf.write(instrumental_path, inst, sr, subtype="PCM_24")


def _level_dips(instrumental_path: str, original_path: Optional[str] = None, vocal_only_path: Optional[str] = None) -> None:
    """Raises quiet dips in an already vocal-free instrumental back toward
    what the surrounding material suggests it should be, in place — vocal
    removal often leaves the instrumental measurably quieter exactly where
    the vocal used to sit (the model's mask attenuates energy there
    generally, not just the vocal's own frequencies), audible as the track
    visibly "ducking" wherever dialogue used to be even after the vocal
    itself is genuinely gone (confirmed live 2026-08-02, alongside
    APEX_CLEANUP_MODEL's fix for the vocal-still-present half of the same
    complaint).

    Prefers comparing directly against the original mix and the isolated
    vocal stem (see _level_dips_reference) when both are available — far
    more precise than guessing from loudness alone, since it only corrects
    where the vocal stem *confirms* a vocal was actually present AND the
    instrumental measurably lost more energy there than the surrounding
    non-vocal material would predict, rather than treating any quiet moment
    as suspect. Falls back to the self-referential trend-based estimate
    (_level_dips_self_referential) if either reference is missing."""
    if original_path and vocal_only_path and os.path.isfile(original_path) and os.path.isfile(vocal_only_path):
        try:
            _level_dips_reference(instrumental_path, original_path, vocal_only_path)
            return
        except Exception:
            app_logger.exception("_level_dips: reference-based leveling failed, falling back to self-referential")
    _level_dips_self_referential(instrumental_path)


def _level_dips_reference(instrumental_path: str, original_path: str, vocal_only_path: str) -> None:
    """See _level_dips's docstring. The correction target isn't the raw
    original mix level (that still includes the vocal's own contribution,
    which would partially defeat the point of removing it) — it's the
    typical instrumental/original loudness RATIO measured from nearby
    NON-vocal passages, i.e. "how full the music usually sits relative to
    the full mix around here," applied as the target for the vocal passages
    too. Only touches windows where the vocal stem confirms a vocal was
    actually present and the drop is large (per the user's own ask: "only
    where it's very different, and only where there was actually vocal")."""
    import numpy as np
    import soundfile as sf
    import librosa

    inst, sr = sf.read(instrumental_path, dtype="float32", always_2d=True)
    n = inst.shape[0]
    if n == 0:
        return
    inst_mono = inst.astype(np.float64).mean(axis=1)

    # Both references get resampled to the instrumental's own sample rate —
    # audio-separator's models don't necessarily output at the source's
    # original rate (e.g. 48kHz in, 44.1kHz out), and the per-window
    # comparison below needs everything aligned sample-for-sample.
    orig_mono = _match_length(librosa.load(original_path, sr=sr, mono=True)[0].astype(np.float64), n)
    voc_mono = _match_length(librosa.load(vocal_only_path, sr=sr, mono=True)[0].astype(np.float64), n)

    window = max(1, int(_DIP_WINDOW_SECONDS * sr))
    hop = max(1, window // 2)
    n_windows = max(1, (n - 1) // hop + 1)
    centers = np.array([i * hop + min(window, n - i * hop) // 2 for i in range(n_windows)])

    inst_rms = _rms_windows(inst_mono, n_windows, window, hop)
    orig_rms = _rms_windows(orig_mono, n_windows, window, hop)
    voc_rms = _rms_windows(voc_mono, n_windows, window, hop)

    eps = 1e-6
    ratio = inst_rms / (orig_rms + eps)  # how much of the original's energy survived into the instrumental

    vocal_present = voc_rms > max(np.percentile(voc_rms, 60), eps * 10)

    # Baseline: the instrumental/original ratio interpolated across
    # vocal-present windows using only non-vocal windows as anchors, so a
    # vocal passage borrows the surrounding music's own typical fullness
    # instead of some fixed target number.
    non_vocal_idx = np.where(~vocal_present)[0]
    if len(non_vocal_idx) < 2:
        baseline_ratio = np.full(n_windows, float(np.median(ratio)))
    else:
        baseline_ratio = np.interp(np.arange(n_windows), non_vocal_idx, ratio[non_vocal_idx])

    max_boost = 10 ** (_DIP_MAX_BOOST_DB / 20)
    gain = np.ones(n_windows, dtype=np.float64)
    # "Only where it's very different" — a mild wobble around the baseline
    # is normal and left alone; only a real drop (instrumental keeping under
    # 70% of the ratio its own surroundings suggest) counts as a dip.
    needs_fix = vocal_present & (ratio < baseline_ratio * 0.7)
    gain[needs_fix] = np.clip(baseline_ratio[needs_fix] / (ratio[needs_fix] + eps), 1.0, max_boost)

    _smooth_gain(gain)

    sample_gain = np.interp(np.arange(n), centers, gain).astype(np.float32)
    inst *= sample_gain[:, None]
    np.clip(inst, -1.0, 1.0, out=inst)
    sf.write(instrumental_path, inst, sr, subtype="PCM_24")


def _level_dips_self_referential(audio_path: str) -> None:
    """Fallback for _level_dips when there's no original-mix/vocal-only
    reference to compare against (see that function's docstring) — guesses
    from the instrumental's own loudness trend instead. Only ever boosts
    (never reduces) a quiet window back toward what the surrounding
    material's own trend suggests it should be; genuinely silent/near-silent
    stretches are excluded so this doesn't turn silence into audible hiss."""
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(audio_path, dtype="float32", always_2d=True)
    n = data.shape[0]
    if n == 0:
        return
    mono = data.astype(np.float64).mean(axis=1)

    window = max(1, int(_DIP_WINDOW_SECONDS * sr))
    hop = max(1, window // 2)
    n_windows = max(1, (n - 1) // hop + 1)
    centers = np.array([i * hop + min(window, n - i * hop) // 2 for i in range(n_windows)])
    rms = _rms_windows(mono, n_windows, window, hop)

    # Long-term trend: a high percentile within a wide rolling window, so a
    # brief quiet dip doesn't drag its own reference level down with it.
    half_trend = max(1, int(_DIP_TREND_SECONDS / (_DIP_WINDOW_SECONDS / 2)) // 2)
    trend = np.empty_like(rms)
    for i in range(n_windows):
        lo, hi = max(0, i - half_trend), min(n_windows, i + half_trend + 1)
        trend[i] = np.percentile(rms[lo:hi], 90)

    eps = 1e-6
    max_boost = 10 ** (_DIP_MAX_BOOST_DB / 20)
    gain = np.clip(trend / (rms + eps), 1.0, max_boost)

    silence_floor = np.percentile(rms, 10) * 0.5
    gain[rms < silence_floor] = 1.0

    _smooth_gain(gain)

    sample_gain = np.interp(np.arange(n), centers, gain).astype(np.float32)
    data *= sample_gain[:, None]
    np.clip(data, -1.0, 1.0, out=data)

    sf.write(audio_path, data, sr, subtype="PCM_24")


# audio-separator's own Separator().list_supported_model_files() groups its
# FULL registry (hundreds of entries — the MODEL_CHOICES above are only a
# curated subset of these) under these 4 category keys, not our 5 method
# names — MDX23C and BS-RoFormer share the same "MDXC" registry category the
# same way they share the "mdxc" architecture above.
_REGISTRY_CATEGORY = {
    "MDX-Net": "MDX",
    "VR Arch": "VR",
    "Demucs": "Demucs",
    "MDX23C": "MDXC",
    "BS-RoFormer": "MDXC",
}

_VOCAL_STEM_NAMES = {"vocals", "instrumental"}

_registry_cache: "dict | None" = None


def _registry() -> dict:
    """audio-separator's full model registry, keyed by category (VR/MDX/
    Demucs/MDXC) then by display label, each value carrying a 'filename' and
    a 'stems' list — e.g. UVR-De-Echo-Normal declares stems ['no echo',
    'echo'], not ['vocals', 'instrumental'], which is exactly how the
    now-removed VR Arch default was confirmed to not be a vocal separator at
    all (see the MODEL_CHOICES comment above). Cached at module level —
    instantiating a Separator() to read this also runs its own ffmpeg/
    onnxruntime environment probe (~1s), and this only needs to happen once
    per process, not once per custom-model add/validation."""
    global _registry_cache
    if _registry_cache is None:
        from audio_separator.separator import Separator
        _ensure_separator_patches()
        _registry_cache = Separator().list_supported_model_files()
    return _registry_cache


def registry_entries_for_method(method: str) -> list[dict]:
    """Every registry entry available for a method — including the ones this
    app doesn't curate into MODEL_CHOICES — for a "browse the full list"
    custom-model picker. is_vocal_separator is None when audio-separator has
    no stems metadata at all for that entry (can't verify either way)."""
    category = _REGISTRY_CATEGORY.get(method)
    if not category:
        return []
    entries = []
    for label, info in _registry().get(category, {}).items():
        filename = info.get("filename")
        if not filename:
            continue
        stems = info.get("stems") or []
        lowered = {s.lower() for s in stems}
        entries.append({
            "label": label,
            "filename": filename,
            "stems": stems,
            "is_vocal_separator": (bool(lowered & _VOCAL_STEM_NAMES) if lowered else None),
        })
    return entries


def check_registry_model(method: str, filename: str) -> tuple[bool, bool, list[str]]:
    """Validates a candidate custom-model filename against audio-separator's
    registry for the given method. Returns (found, looks_like_vocal_separator,
    stems) — found is False for a typo'd/unknown filename; when found,
    looks_like_vocal_separator is False only when the registry positively
    declares non-vocal stems (e.g. de-echo/de-reverb/denoise/drum-sep tools),
    and True (benefit of the doubt) when there's no stems metadata to check at
    all, since plenty of legitimate registry entries carry none."""
    category = _REGISTRY_CATEGORY.get(method)
    if not category:
        return False, False, []
    for info in _registry().get(category, {}).values():
        if info.get("filename") == filename:
            stems = info.get("stems") or []
            lowered = {s.lower() for s in stems}
            looks_vocal = (bool(lowered & _VOCAL_STEM_NAMES) if lowered else True)
            return True, looks_vocal, stems
    return False, False, []


_MODEL_FILE_EXTENSIONS = {".onnx", ".ckpt", ".pth", ".th", ".yaml", ".yml"}


def downloaded_model_filenames() -> list[str]:
    """Every checkpoint/config file already sitting in the shared models
    dir — lets the Model Browser show "Завантажено" instead of "Завантажити"
    without a network round-trip. Filtered to known model/config extensions
    — audio-separator itself writes its own housekeeping files into this
    same directory (confirmed live: a "download_checks.json" hash-cache),
    which would otherwise show up as a phantom "downloaded model" with a
    nonsense name."""
    models_dir = Path(DATA_DIR) / "models"
    if not models_dir.is_dir():
        return []
    return [
        p.name for p in models_dir.iterdir()
        if p.is_file() and p.suffix.lower() in _MODEL_FILE_EXTENSIONS
    ]


def delete_downloaded_model(filename: str) -> None:
    """Removes a downloaded checkpoint from THIS install's disk (freeing up
    space / clearing out a bad download) — never touches the shared Model
    Browser catalog itself (see routers/model_browser.py's /catalog for
    that), only this one machine's local copy. Also removes the companion
    YAML config file and the DownloadedCustomModel row if this was a
    custom/community model, so it correctly drops out of the separation
    dropdown too (see list_model_choices) rather than lingering as a
    selectable option pointing at a now-missing file."""
    if os.sep in filename or (os.altsep and os.altsep in filename) or filename in ("..", "."):
        raise ValueError("Невірна назва файлу")

    models_dir = Path(DATA_DIR) / "models"
    model_path = models_dir / filename
    if model_path.is_file():
        model_path.unlink()

    from ..models import DownloadedCustomModel
    db = SessionLocal()
    try:
        row = db.query(DownloadedCustomModel).filter_by(filename=filename).first()
        if row:
            if row.config_yaml_filename:
                yaml_path = models_dir / row.config_yaml_filename
                if yaml_path.is_file():
                    yaml_path.unlink()
            db.delete(row)
            db.commit()
    finally:
        db.close()


def download_model(method: str, filename: str, reporter: ProgressReporter) -> dict:
    """Downloads one registry model's file(s) into the shared models dir
    ahead of time, via the Model Browser — same download_model_files() UVR's
    own Separator.load_model() would trigger on first actual use, just
    surfaced as its own job so the user can pre-fetch a model without running
    a separation. No GPU patch needed here (unlike an actual separation run)
    — Separator.__init__ doesn't touch setup_torch_device, only load_model()
    does, and this never calls load_model().

    Also records the download in DownloadedCustomModel (unless it's already
    one of the curated MODEL_CHOICES, which the separation dropdown already
    offers regardless) — without this, downloading some model from the
    Browser's full-registry list that isn't in the curated set would fetch
    the file to disk successfully but then never actually show up as a
    selectable option in "Ізоляція вокалу", confirmed live as a real report."""
    from audio_separator.separator import Separator
    reporter.update(10, f"Завантаження {filename}…")
    sep = Separator(model_file_dir=str(Path(DATA_DIR) / "models"))
    sep.download_model_files(filename)

    if not any(f == filename for _, f in MODEL_CHOICES.get(method, [])):
        label = filename
        for entry in registry_entries_for_method(method):
            if entry["filename"] == filename:
                label = entry["label"]
                break
        from ..models import DownloadedCustomModel
        db = SessionLocal()
        try:
            row = db.query(DownloadedCustomModel).filter_by(filename=filename).first()
            if not row:
                db.add(DownloadedCustomModel(method=method, filename=filename, label=label, arch=MODEL_ARCH[method]))
                db.commit()
        finally:
            db.close()

    reporter.update(100, "Завантажено")
    return {"filename": filename}


def _download_file(url: str, dest: Path, on_progress: Optional[Callable[[int, int], None]] = None) -> None:
    import requests
    resp = requests.get(url, stream=True, timeout=300)
    resp.raise_for_status()

    # A same-size existing file is treated as "already downloaded, skip" —
    # but ONLY when we can actually confirm the size matches. Previously
    # this skipped on mere file existence, which silently no-op'd on a
    # partial/corrupt leftover from an earlier interrupted attempt (killed
    # process, network drop) — confirmed live as a real report: a re-download
    # "started and immediately stopped" because it was skipping the transfer
    # entirely and reporting the stale partial file as done.
    expected_size = resp.headers.get("content-length")
    if dest.is_file() and expected_size is not None and dest.stat().st_size == int(expected_size):
        resp.close()
        return

    total = int(expected_size) if expected_size is not None else 0
    downloaded = 0
    # 1MB chunks instead of requests' 8KB default — these are routinely
    # multi-hundred-MB checkpoint files (confirmed live: 870MB+ for a single
    # Model Browser download), and the per-chunk Python-level overhead of
    # 8KB reads meaningfully caps achievable throughput on a fast connection.
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1024 * 1024):
            f.write(chunk)
            downloaded += len(chunk)
            if on_progress:
                on_progress(downloaded, total)


# Keys that only appear in a transformer-based Roformer config (BS-Roformer /
# Mel-Band-Roformer) — never in a convolutional TFC-TDF (MDX23C) config.
_ROFORMER_SIGNATURE_KEYS = {"flash_attn", "dim_head", "heads", "depth"}
# Mel-Band-Roformer-specific (banding done in mel-frequency space); BS-Roformer
# instead uses "freqs_per_bands" — presence of either one is how
# audio-separator's OWN ConfigurationNormalizer.detect_model_type tells the
# two apart (see roformer/configuration_normalizer.py), just never on a
# nested "model:" section — only at the config's top level (see below).
_MEL_BAND_SIGNATURE_KEYS = {"num_bands", "n_mels", "mel_bands"}
_BS_ROFORMER_SIGNATURE_KEYS = {"freqs_per_bands"}


def _ensure_roformer_flag(yaml_path: Path) -> None:
    """Two separate, independently-broken auto-detection steps stand between
    a community "add by URL" config and actually loading as the right model:

    1. audio-separator's MDXCSeparator picks Roformer vs the MDX23C/TFC-TDF
       network (both share the "mdxc" umbrella architecture — see
       MODEL_ARCH's comment) by checking whether "roformer" appears in the
       checkpoint's filename/model name, or an explicit `is_roformer: true`
       key — see common_separator.py's _detect_roformer_model(). A random
       community checkpoint filename (confirmed live: "inst_gabox.ckpt", a
       genuine Mel-Band-Roformer per its own dim/depth/heads/flash_attn
       keys) routinely has neither, and silently loads as TFC-TDF instead —
       crashing on a missing "num_subbands" key only TFC-TDF's config shape
       has.
    2. Having fixed #1, RoformerLoader.normalize_from_file_path then ALSO
       needs to pick BS-Roformer vs Mel-Band-Roformer specifically. It tries
       the filename first (same problem as #1), then falls back to
       ConfigurationNormalizer.detect_model_type(config) — which checks for
       "num_bands"/"freqs_per_bands" etc. at the config's TOP level only,
       never inside a nested "model:" section the way every real-world YAML
       from this model family actually stores them. That lookup comes up
       empty and it defaults to "bs_roformer" regardless — confirmed live:
       "inst_gabox.ckpt" (needs Mel-Band-Roformer) got loaded via the
       BS-Roformer class instead, crashing immediately on an STFT band-count
       mismatch (a completely different error from #1, only visible after
       #1 was already fixed).

    Both are worked around the same way: since our own arch="mdxc"
    classification already covers this whole family, and the config's own
    keys make it unambiguous which exact sub-type it is, write the flags
    audio-separator is actually looking for directly into the file, rather
    than relying on either the checkpoint's filename or the config's nested
    shape to happen to match what its detectors expect."""
    import yaml

    try:
        with open(yaml_path, "r", encoding="utf-8") as f:
            data = yaml.load(f, Loader=yaml.FullLoader)
    except Exception:
        return  # not parseable — leave it untouched, load_model_data_from_yaml will surface the real error

    if not isinstance(data, dict):
        return
    model_section = data.get("model")
    if not isinstance(model_section, dict) or not (_ROFORMER_SIGNATURE_KEYS & model_section.keys()):
        return  # doesn't look like a Roformer config at all — leave audio-separator's own detection alone

    changed = False
    if not data.get("is_roformer"):
        data["is_roformer"] = True
        changed = True

    if not data.get("model_type"):
        if _MEL_BAND_SIGNATURE_KEYS & model_section.keys():
            data["model_type"] = "mel_band_roformer"
            changed = True
        elif _BS_ROFORMER_SIGNATURE_KEYS & model_section.keys():
            data["model_type"] = "bs_roformer"
            changed = True
        # else: genuinely ambiguous (neither signature present) — leave
        # unset rather than guessing; worst case it falls back to the
        # library's own bs_roformer default, same as before this function
        # existed at all.

    if changed:
        with open(yaml_path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)


def download_custom_model(
    method: str,
    filename: str,
    label: str,
    arch: str,
    download_url: str,
    config_yaml_url: Optional[str],
    reporter: ProgressReporter,
) -> dict:
    """Downloads a Model Browser catalog entry that ISN'T in audio-separator's
    own registry (added via the "add by URL" AI auto-configure flow — see
    routers/model_browser.py) straight from its resolved download_url/
    config_yaml_url, via plain HTTP rather than Separator.download_model_files
    (which only knows its own built-in registry). Records the result in
    DownloadedCustomModel so _patch_custom_model_loading can resolve it at
    separation time without hitting the network again."""
    from ..models import DownloadedCustomModel

    models_dir = Path(DATA_DIR) / "models"
    models_dir.mkdir(parents=True, exist_ok=True)

    # Real byte-level progress rather than a static "10%" for the whole
    # transfer — these are routinely 500MB-1GB+ files (confirmed live: a
    # 913MB checkpoint sat "stuck" at 10% in the UI for the entire download,
    # reported as looking frozen, since nothing updated the percent again
    # until the whole thing finished).
    def _progress(base_pct: int, span_pct: int, label: str):
        last_pct = -1

        def _cb(downloaded: int, total: int):
            nonlocal last_pct
            if not total:
                return
            frac = min(downloaded / total, 1.0)
            pct = base_pct + int(frac * span_pct)
            if pct == last_pct:
                return  # throttled — a 1MB chunk on a fast connection can fire hundreds of
                        # times a second; only broadcast when the shown percent actually moves
            last_pct = pct
            mb_done = downloaded / (1024 * 1024)
            mb_total = total / (1024 * 1024)
            reporter.update(pct, f"{label} {mb_done:.0f}/{mb_total:.0f} МБ…")
        return _cb

    reporter.update(2, f"Завантаження {filename}…")
    _download_file(download_url, models_dir / filename, on_progress=_progress(2, 68, f"Завантаження {filename}:"))

    config_yaml_filename = None
    if config_yaml_url:
        config_yaml_filename = os.path.basename(config_yaml_url.split("?")[0])
        reporter.update(70, "Завантаження конфігурації…")
        _download_file(config_yaml_url, models_dir / config_yaml_filename, on_progress=_progress(70, 18, "Завантаження конфігурації:"))
        if arch == "mdxc":
            _ensure_roformer_flag(models_dir / config_yaml_filename)

    reporter.update(90, "Реєстрація моделі…")
    db = SessionLocal()
    try:
        row = db.query(DownloadedCustomModel).filter_by(filename=filename).first()
        if row:
            row.method, row.label, row.arch, row.config_yaml_filename = method, label, arch, config_yaml_filename
        else:
            db.add(DownloadedCustomModel(
                method=method, filename=filename, label=label, arch=arch,
                config_yaml_filename=config_yaml_filename,
            ))
        db.commit()
    finally:
        db.close()

    reporter.update(100, "Завантажено")
    return {"filename": filename}


def sync_model_ratings_from_remote(db: Session, remote: list[dict]) -> None:
    """Merges the Worker's full rating list into the local cache — unlike
    Апекс's line-up sync, this is an upsert-per-row merge rather than a
    full-table replace, since ratings come from many independent profiles
    across installs rather than one admin curating a single shared list."""
    from .. import models as db_models
    changed = False
    for item in remote:
        method = item.get("method")
        filename = item.get("filename")
        profile_name = item.get("profile_name")
        rating = item.get("rating")
        if not (method and filename and profile_name) or not isinstance(rating, int):
            continue
        row = (
            db.query(db_models.ModelRating)
            .filter_by(method=method, filename=filename, profile_name=profile_name)
            .first()
        )
        if row:
            if row.rating != rating:
                row.rating = rating
                changed = True
        else:
            db.add(db_models.ModelRating(method=method, filename=filename, profile_name=profile_name, rating=rating))
            changed = True
    if changed:
        db.commit()


def list_model_choices(db) -> dict:
    """Built-in curated MODEL_CHOICES plus any Model Browser catalog entries
    already downloaded onto THIS install (see DownloadedCustomModel and
    routers/model_browser.py) — the single source of truth the frontend
    fetches instead of keeping its own hardcoded copy. (A prior hardcoded
    copy in VocalSeparationModal.tsx drifted out of sync with a
    MODEL_CHOICES fix here and kept offering a model already confirmed
    broken — see git history, commit 40b95fe.) A custom model only shows up
    here once downloaded — merely existing in the shared browser catalog
    isn't enough, since separation needs the actual file on disk."""
    from ..models import DownloadedCustomModel
    choices: dict[str, list[dict]] = {
        method: [{"label": label, "file": file, "custom": False, "id": None} for label, file in entries]
        for method, entries in MODEL_CHOICES.items()
    }
    for row in db.query(DownloadedCustomModel).order_by(DownloadedCustomModel.id).all():
        choices.setdefault(row.method, []).append(
            {"label": row.label, "file": row.filename, "custom": True, "id": row.id}
        )
    return {"methods": list(MODEL_CHOICES.keys()), "choices": choices}


def separate_file(
    audio_path: str,
    output_dir: str,
    model_name: str,
    ensemble: bool,
    model_file: Optional[str] = None,  # specific checkpoint filename — see MODEL_CHOICES; defaults to MODEL_MAP[model_name] if omitted
    params: Optional[dict] = None,  # {"mdx"|"vr"|"demucs"|"mdxc": {...}} — see MODEL_ARCH
    on_progress=None,  # Optional[Callable[[int, str], None]] — no DB/job coupling
    is_cancelled=None,  # Optional[Callable[[], bool]]
    profile_id: Optional[int] = None,  # only consulted for PERSONAL_ENSEMBLE_METHOD — see _load_personal_ensemble_models
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
    _ensure_separator_patches()

    app_logger.info(
        "separate_file: start audio_path=%s output_dir=%s model_name=%s ensemble=%s model_file=%s params=%s",
        audio_path, output_dir, model_name, ensemble, model_file, params,
    )
    if not os.path.isfile(audio_path):
        app_logger.error("separate_file: audio_path does not exist: %s", audio_path)

    os.makedirs(output_dir, exist_ok=True)

    if ensemble:
        jobs = [(method, MODEL_MAP[method], MODEL_ARCH[method]) for method in MODEL_MAP]
    elif model_name == APEX_METHOD:
        # Апекс has no single checkpoint of its own — see APEX_MODELS_DEFAULT'
        # comment. A model_file override makes no more sense here than it
        # does for the generic Ensemble Mode above. Line-up is DB-backed
        # (live-editable), not the hardcoded default — see _load_apex_models.
        jobs = _load_apex_models()
    elif model_name == PERSONAL_ENSEMBLE_METHOD:
        jobs = _load_personal_ensemble_models(profile_id)
        if not jobs:
            raise RuntimeError(
                "Мій ансамбль порожній — додайте моделі у Браузері моделей перед запуском"
            )
    else:
        # A specific-checkpoint override only applies to this single-method
        # path — ensemble/Апекс always run their own fixed model set.
        jobs = [(model_name, model_file or MODEL_MAP.get(model_name, model_name), MODEL_ARCH.get(model_name))]

    vocal_stems: list[str] = []
    instrumental_stems: list[str] = []

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    for idx, (mdl, uvr_model, arch) in enumerate(jobs):
        if is_cancelled and is_cancelled():
            raise RuntimeError("Скасовано")

        base_pct = int(idx / len(jobs) * 80)
        progress(base_pct + 5, f"нейромережа: завантаження моделі {mdl}…")

        sep_kwargs = dict(
            output_dir=output_dir,
            output_format="WAV",
            normalization_threshold=0.9,
            model_file_dir=str(Path(DATA_DIR) / "models"),
        )
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
            target=_heartbeat, args=(base_pct + 15, base_pct + int(80 / len(jobs)) - 2), daemon=True,
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
        if vocal_file is None and instrumental_file is None and output_paths:
            # Neither filename mentions "vocal" or "instrumental" — this
            # model's output isn't actually a vocal/instrumental pair at all
            # (see the VR Arch MODEL_CHOICES comment above for a confirmed
            # real case: a de-echo model producing "No Echo"/"Echo" stems).
            # The positional fallback below still runs so separation doesn't
            # outright fail, but whatever it picks is not guaranteed to be a
            # real instrumental — flagged loudly so a future bad model
            # choice shows up in the log instead of silently mislabeling.
            app_logger.warning(
                "separate_file: model %s's output has neither 'vocal' nor 'instrumental' "
                "in any filename (%s) — this model may not be a real vocal separator; "
                "falling back to a positional guess",
                mdl, output_paths,
            )
        if not vocal_file and output_paths:
            vocal_file = output_paths[0]
        if not instrumental_file:
            remaining = [f for f in output_paths if f != vocal_file]
            instrumental_file = remaining[0] if remaining else None

        if vocal_file and os.path.isfile(vocal_file):
            vocal_stems.append(vocal_file)
        if instrumental_file and os.path.isfile(instrumental_file):
            instrumental_stems.append(instrumental_file)

        progress(base_pct + int(80 / len(jobs)), f"нейромережа: готово {mdl}")

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

    # Computed here (moved ahead of the Апекс post-processing below) so
    # _level_dips can use it as a reference — it's the one signal that
    # confirms WHERE a vocal actually was, distinct from any other reason a
    # passage might legitimately be quiet.
    final_vocal_only = None
    if vocal_stems:
        final_vocal_only = str(Path(output_dir) / "vocal_only.wav")
        if len(vocal_stems) == 1:
            shutil.copy2(vocal_stems[0], final_vocal_only)
        else:
            _average_stems(vocal_stems, final_vocal_only)

    if model_name == APEX_METHOD:
        # The same mdxc segment/overlap the UI sends for Апекс (see
        # VocalSeparationModal.tsx's buildParams) already applied to this
        # method's own mdxc-arch jobs above via the generic
        # `params.get(arch)` check in the loop — reused here for the
        # cleanup pass too, so one settings panel covers both.
        _apex_cleanup_pass(final_instrumental, output_dir, progress, mdxc_params=(params or {}).get("mdxc"))
        progress(98, "нейромережа: вирівнювання гучності…")
        _level_dips(final_instrumental, audio_path, final_vocal_only)
        if final_vocal_only:
            progress(99, "нейромережа: перевірка залишків вокалу…")
            _suppress_leaks(final_instrumental, final_vocal_only)

    progress(100, "нейромережа: вокал відокремлено")
    return {"vocal_stem_path": final_instrumental, "vocal_only_stem_path": final_vocal_only}


# --- Separation-run reports for the admin ---
#
# Every local or distributed separation run gets a report: who ran it, which
# model, how long it took, whether it succeeded/failed/was cancelled
# (including "quiet" warnings that only ever reached app.log before — see
# _WarningCapture), and who helped if it was distributed. Saved locally
# under DATA_DIR/reports/ on the machine that ran it either way, and
# additionally relayed to the admin over the same Cloudflare Worker
# feedback already uses — that half is best-effort (see _dispatch_report)
# since a report is diagnostic, not something a failed network send should
# ever be allowed to turn into a failed separation.

REPORTS_DIR = Path(DATA_DIR) / "reports"


class _WarningCapture(logging.Handler):
    """Buffers WARNING+ log records emitted anywhere via app_logger while
    attached, so a separation run's report can include things that
    previously only ever reached app.log silently — e.g. _apex_cleanup_pass
    catching its own exception and carrying on, or the "positional guess"
    warning when a model's output doesn't look like a real vocal/
    instrumental pair."""

    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.messages: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        try:
            self.messages.append(self.format(record))
        except Exception:
            pass


def _local_timezone_label() -> str:
    """UTC offset (e.g. "UTC+03:00") for whoever's machine this is running
    on — simpler and more portable than resolving this OS's IANA timezone
    name, and enough to let the admin's client show "their time (UTC+X)"
    next to the admin's own local time for the same instant."""
    offset = datetime.now().astimezone().utcoffset()
    if offset is None:
        return "UTC+00:00"
    total_minutes = int(offset.total_seconds() // 60)
    sign = "+" if total_minutes >= 0 else "-"
    hh, mm = divmod(abs(total_minutes), 60)
    return f"UTC{sign}{hh:02d}:{mm:02d}"


def _active_profile_name(db) -> str:
    settings = db.get(AppSettings, 1)
    if settings and settings.active_profile_id:
        profile = db.get(Profile, settings.active_profile_id)
        if profile and profile.name.strip():
            return profile.name.strip()
    return "Анонім"


def _episode_label(db, episode_id: int) -> str:
    ep = db.get(Episode, episode_id)
    if not ep:
        return f"episode {episode_id}"
    title = db.get(Title, ep.title_id)
    title_name = title.name_ua if title else "?"
    return f"{title_name} S{ep.season:02d}E{ep.number:02d}"


def _dispatch_report(report: dict) -> None:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    report_id = report["id"]
    try:
        with open(REPORTS_DIR / f"{report_id}.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except OSError:
        app_logger.exception("_dispatch_report: failed to save report locally")

    try:
        from . import discovery_service
        discovery_service.submit_report(report)
    except Exception:
        # Best-effort — no online signaling configured, or the Worker is
        # unreachable, should never turn a diagnostic report into a failed
        # separation. The local copy above is the guaranteed record.
        app_logger.info("_dispatch_report: could not relay report to admin (kept local copy only)")


@contextlib.contextmanager
def _report_separation_run(episode_id: int, model_name: str, ensemble: bool, distributed: bool, peers_used: Optional[list[str]] = None):
    """Wraps a separation run (local or distributed) end-to-end, timing it
    and capturing warnings, then dispatches a report regardless of how it
    ended. Re-raises whatever the wrapped code raised — this only observes,
    it never changes the run's own success/failure outcome.

    Yields a mutable dict the caller can update mid-run — e.g.
    run_distributed_separation doesn't know which peers actually ended up
    contributing (vs. failing and being redone locally) until partway
    through, so it fills in ctx["peers_used"] once that's known, rather than
    this needing it all upfront."""
    started_at = datetime.now(timezone.utc)
    t0 = time.monotonic()
    capture = _WarningCapture()
    app_logger.addHandler(capture)
    ctx = {"peers_used": list(peers_used or [])}
    status = "error"
    error_message = None
    try:
        yield ctx
        status = "success"
    except Exception as exc:
        error_message = str(exc)
        status = "cancelled" if error_message == "Скасовано" else "error"
        raise
    finally:
        app_logger.removeHandler(capture)
        db = SessionLocal()
        try:
            report = {
                "id": str(uuid.uuid4()),
                "profile_name": _active_profile_name(db),
                "user_timezone": _local_timezone_label(),
                "episode_label": _episode_label(db, episode_id),
                "model": model_name,
                "ensemble": ensemble,
                "distributed": distributed,
                "peers_used": ctx["peers_used"],
                "duration_seconds": round(time.monotonic() - t0, 1),
                "status": status,
                "error_message": error_message,
                "warnings": capture.messages,
                "started_at_utc": started_at.isoformat(),
            }
        finally:
            db.close()
        _dispatch_report(report)


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

        settings = db.get(AppSettings, 1)
        profile_id = settings.active_profile_id if settings else None

        with _report_separation_run(episode_id, model_name, ensemble, distributed=False):
            try:
                stems = separate_file(
                    audio_path, str(output_dir), model_name, ensemble, model_file=model_file, params=params,
                    on_progress=reporter.update, is_cancelled=lambda: reporter.cancelled,
                    profile_id=profile_id,
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
    title_name: str,
    season: int,
    episode_number: int,
    on_progress=None,  # Optional[Callable[[int, str], None]]
    is_cancelled=None,  # Optional[Callable[[], bool]]
) -> dict[str, str]:
    """Runs EVERY model listed under EVERY method in MODEL_CHOICES (not just
    each method's default) — unlike Ensemble Mode, keeps each one's own
    instrumental as a SEPARATE file instead of averaging them into one
    blended result, for comparing models side by side or rendering with
    whichever one turns out best per-episode, rather than committing to a
    single averaged guess or a single default-per-method guess. Only the
    instrumental is kept (not the isolated-vocal counterpart) — this mode is
    for picking/comparing a final instrumental track, which is the only
    thing dubbing actually needs; FLAC, not WAV, to keep the output size
    down to something reasonable while staying lossless.

    This runs every model the app curates (see MODEL_CHOICES — currently 29
    across 5 methods), not just 5 — expect this to take roughly 5-6x as long
    as the old one-model-per-method behavior; GPU acceleration (Налаштування)
    makes a large difference here.

    Results land in <output_dir>/<title>/<method>/<title>_S..E..(<model>).flac
    — one subfolder per method (MDX-Net, VR Arch, …) holding every model that
    method offers, episode tag in the filename so different episodes of the
    same title never collide, and the specific model's own display name (not
    just the method) in parentheses so files sharing a method folder stay
    distinguishable.

    Returns {"<method> — <model>": instrumental_flac_path} — deliberately
    does not touch any Episode column (there's no single "the" result to
    promote the way normal/ensemble separation has), so the episode's status
    and vocal_stem_path are left exactly as they were before this ran."""
    try:
        from audio_separator.separator import Separator
    except ImportError:
        app_logger.exception("separate_file_batch: audio-separator not installed")
        raise RuntimeError("audio-separator not installed. Run: pip install audio-separator")
    _ensure_separator_patches()

    app_logger.info("separate_file_batch: start audio_path=%s output_dir=%s", audio_path, output_dir)
    safe_title = _sanitize_filename(title_name)
    ep_tag = f"S{season:02d}E{episode_number:02d}"
    jobs = [
        (method, model_label, model_file)
        for method, choices in MODEL_CHOICES.items()
        for model_label, model_file in choices
    ]
    results: dict[str, str] = {}

    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    for idx, (method, model_label, uvr_model) in enumerate(jobs):
        if is_cancelled and is_cancelled():
            raise RuntimeError("Скасовано")

        base_pct = int(idx / len(jobs) * 90)
        progress(base_pct + 1, f"нейромережа: завантаження моделі {method} — {model_label}…")

        method_dir = Path(output_dir) / safe_title / _sanitize_filename(method)
        method_dir.mkdir(parents=True, exist_ok=True)

        sep = Separator(
            output_dir=str(method_dir),
            output_format="FLAC",
            normalization_threshold=0.9,
            model_file_dir=str(Path(DATA_DIR) / "models"),
        )
        try:
            sep.load_model(uvr_model)
        except Exception:
            app_logger.exception("separate_file_batch: failed to load model %s (%s, file=%s)", model_label, method, uvr_model)
            raise

        progress(base_pct + int(90 / len(jobs) / 2), f"нейромережа: ізоляція вокалу ({method} — {model_label})…")
        try:
            output_files = sep.separate(audio_path)
        except Exception:
            app_logger.exception("separate_file_batch: sep.separate() failed for %s (%s)", model_label, method)
            raise
        output_paths = [
            f if os.path.isabs(f) else str(method_dir / f)
            for f in output_files
        ]

        # Only the instrumental is kept for batch mode (see docstring) — no
        # need to even locate the vocal-only counterpart.
        instrumental_file = next((f for f in output_paths if "instrumental" in f.lower()), None)
        if not instrumental_file and output_paths:
            # No filename says "instrumental" — this model may not be a real
            # vocal separator at all (see the VR Arch MODEL_CHOICES comment
            # above for a confirmed real case). Flagged loudly rather than
            # silently guessing positionally and shipping the wrong audio.
            app_logger.warning(
                "separate_file_batch: %s (%s) produced no filename containing 'instrumental' (%s) — "
                "falling back to a positional guess; this model may not be a real vocal separator",
                model_label, method, output_paths,
            )
            instrumental_file = output_paths[0]

        if instrumental_file and os.path.isfile(instrumental_file):
            file_name = f"{safe_title}_{ep_tag}_{_sanitize_filename(method)}({_sanitize_filename(model_label)}).flac"
            final_instrumental = str(method_dir / file_name)
            # move, not copy — a copy would leave audio-separator's own raw
            # output file sitting right next to the renamed one, doubling
            # this method's disk usage for no reason (pre-existing bug,
            # caught while verifying the new folder layout above).
            shutil.move(instrumental_file, final_instrumental)
            results[f"{method} — {model_label}"] = final_instrumental
        # Every intermediate file audio-separator wrote for this model
        # (including whichever one WASN'T the instrumental — the isolated
        # vocal stem this mode doesn't keep) is no longer needed once its
        # renamed copy exists — without cleanup, output_dir would keep every
        # model's raw output on top of the renamed copies.
        for f in output_paths:
            if f != instrumental_file and os.path.isfile(f):
                os.remove(f)

        progress(base_pct + int(90 / len(jobs)), f"нейромережа: готово {method} — {model_label}")

    progress(100, "нейромережа: всі моделі оброблено")
    app_logger.info("separate_file_batch: done, results=%s", results)
    return results


BATCH_LIBRARY_MAX_AGE_DAYS = 3


def cleanup_stale_batch_libraries() -> int:
    """Deletes any per-episode batch-separation folder (separate_file_batch's
    "every model, listen and pick" library) older than
    BATCH_LIBRARY_MAX_AGE_DAYS — it's meant as a temporary A/B comparison
    while deciding which model to render with, not permanent storage, and
    every curated model's own FLAC output can add up to several GB per
    episode across ~29 models. Called periodically from main.py's lifespan.
    Returns how many episode libraries were removed."""
    episodes_dir = Path(DATA_DIR) / "episodes"
    if not episodes_dir.is_dir():
        return 0
    cutoff = time.time() - BATCH_LIBRARY_MAX_AGE_DAYS * 86400
    removed = 0
    for batch_dir in episodes_dir.glob("*/stems/batch"):
        try:
            if batch_dir.is_dir() and batch_dir.stat().st_mtime < cutoff:
                shutil.rmtree(batch_dir, ignore_errors=True)
                removed += 1
        except OSError:
            continue
    return removed


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
        title = db.get(Title, ep.title_id)
        title_name = title.name_ua if title else "Untitled"

        if output_dir:
            output_dir = Path(output_dir)
        else:
            ep_dir = Path(DATA_DIR) / "episodes" / str(episode_id)
            output_dir = ep_dir / "stems" / "batch"

        try:
            results = separate_file_batch(
                audio_path, str(output_dir), title_name, ep.season, ep.number,
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
