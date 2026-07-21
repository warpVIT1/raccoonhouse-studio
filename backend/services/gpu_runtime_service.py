"""
On-demand CUDA runtime for GPU acceleration.

GPU support is off by default and needs roughly 2.5GB of CUDA/cuDNN/cuFFT
DLLs (onnxruntime-gpu's provider DLL alone is ~712MB) that the installer
deliberately does not bundle (see build-backend.py) — bundling them would
balloon the installer for every user, including the ones with no NVIDIA GPU
at all. Instead this downloads them once, into a persistent cache directory
under RH_DATA_DIR (Electron's userData) rather than anywhere inside the
versioned install directory — NSIS overwrites the install directory on every
update but never touches userData, so the download survives app updates.

onnxruntime hardcodes looking for its CUDA provider DLL in its OWN package
directory (next to onnxruntime.dll), not via a PATH search — confirmed live
2026-07-19 (LoadLibrary is called with an absolute path built from the
package's own location). That directory sits INSIDE the versioned install
tree, so it gets wiped on every update. _ensure_gpu_provider_placed() below
re-links the cached files into that directory on every startup — a hardlink,
not a copy, so it's instant and costs no extra disk space; it only actually
does anything right after an update replaced the install directory.
"""
import os
import shutil
import subprocess
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
GPU_RUNTIME_DIR = Path(DATA_DIR) / "gpu-runtime"
GPU_RUNTIME_MARKER = GPU_RUNTIME_DIR / ".installed"

# The archives holding onnxruntime_providers_cuda.dll + cublas/cudnn/cufft/
# cudart DLLs, flat (no subfolders) — built from the same nvidia-*-cu12 pip
# packages + onnxruntime-gpu used in dev (see requirements.txt). Hosted as a
# dedicated pre-release (tag gpu-runtime-v1, NOT an app version — see its own
# release notes) rather than bundled anywhere. Split into two parts: the
# combined raw size (~3.0GB) exceeds GitHub's 2GiB *per-asset* limit — that
# limit applies to every individual release asset, not just a packaged
# installer, so one zip wouldn't have worked regardless of which release
# it was attached to. Re-verify these are still the current URLs if the
# libraries are ever rebuilt/re-uploaded (e.g. a version bump makes the old
# tag's assets stale).
GPU_RUNTIME_URLS = os.environ.get(
    "RH_GPU_RUNTIME_URLS",
    "https://github.com/warpVIT1/raccoonhouse-studio/releases/download/gpu-runtime-v1/cuda-runtime-part1.zip,"
    "https://github.com/warpVIT1/raccoonhouse-studio/releases/download/gpu-runtime-v1/cuda-runtime-part2.zip",
).split(",")


def has_nvidia_gpu() -> bool:
    """Cheap check via nvidia-smi — avoids offering (and downloading for) GPU
    support on AMD/Intel/no-GPU machines where it could never work anyway."""
    try:
        subprocess.run(["nvidia-smi", "-L"], capture_output=True, timeout=5, check=True)
        return True
    except Exception:
        return False


def is_gpu_runtime_installed() -> bool:
    return GPU_RUNTIME_MARKER.is_file()


def _onnxruntime_capi_dir() -> Path:
    import onnxruntime
    return Path(onnxruntime.__file__).parent / "capi"


def ensure_gpu_provider_placed() -> None:
    """Re-links the cached runtime files into onnxruntime's own capi/
    directory if they're not already there — cheap no-op after the first
    call following any given install/update. Safe to call unconditionally;
    does nothing if the runtime was never downloaded."""
    if not is_gpu_runtime_installed():
        return
    capi_dir = _onnxruntime_capi_dir()
    capi_dir.mkdir(parents=True, exist_ok=True)
    for src in GPU_RUNTIME_DIR.iterdir():
        if src.name.startswith("."):
            continue
        dst = capi_dir / src.name
        if dst.exists():
            continue
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)


def install_gpu_runtime(on_progress=None) -> None:
    """Downloads the CUDA runtime archive and extracts it into the
    persistent cache, then places it alongside onnxruntime for immediate
    use. on_progress(pct: int, message: str), matching job_manager's
    ProgressReporter.update signature."""
    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    GPU_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    n = len(GPU_RUNTIME_URLS)
    for i, url in enumerate(GPU_RUNTIME_URLS):
        base = int(i / n * 78)
        span = 78 // n
        zip_path = GPU_RUNTIME_DIR / os.path.basename(url)

        progress(base + 2, "Завантаження бібліотек CUDA…")
        request = Request(url, headers={"User-Agent": "RaccoonHouse-Studio"})
        with urlopen(request, timeout=30) as resp:
            total = int(resp.headers.get("Content-Length", 0)) or 1
            downloaded = 0
            with open(zip_path, "wb") as f:
                while True:
                    chunk = resp.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    progress(base + 2 + int(downloaded / total * span), "Завантаження бібліотек CUDA…")

        progress(base + span, "Розпакування…")
        with zipfile.ZipFile(zip_path) as zf:
            for name in zf.namelist():
                filename = os.path.basename(name)
                if not filename:  # directory entry
                    continue
                with zf.open(name) as src, open(GPU_RUNTIME_DIR / filename, "wb") as dst:
                    shutil.copyfileobj(src, dst)
        zip_path.unlink(missing_ok=True)

    GPU_RUNTIME_MARKER.write_text("ok")

    progress(95, "Підключення бібліотек…")
    ensure_gpu_provider_placed()

    progress(100, "GPU-прискорення встановлено")


# --- Torch/torchvision CUDA build (VR Arch, Demucs, MDX23C, BS-RoFormer) ---
#
# onnxruntime's CUDA support (above) is a genuine plugin — one DLL, loaded
# by name at runtime, so it can be added after the fact with no other
# changes. torch has no such plugin boundary: its CPU and CUDA builds are
# two entirely different compiled packages (confirmed live 2026-07-19:
# torch.backends.cuda.is_built() is False on the bundled CPU build — it's
# not "CPU build missing a DLL", it's compiled without CUDA support at all).
# Getting GPU acceleration for the torch-based models therefore means
# downloading torch AND torchvision's CUDA builds wholesale and shadowing
# the bundled CPU ones via sys.path, ahead of any import of either anywhere
# in the process (see torch_cuda_sys_path() and backend/main.py).
#
# Versions must exactly match requirements.txt's torch==2.13.0/
# torchvision==0.28.0 — confirmed live 2026-07-19 that download.pytorch.org's
# cu126 index carries identical versions, just CUDA-enabled, so no other
# dependency in the app (torchaudio is decoupled via vad_service.py's stub;
# audio-separator/onnx2torch's own version constraints are satisfied either
# way since the version number itself doesn't change) needs to move at all.
# If requirements.txt's torch/torchvision versions ever change, these need
# to be re-resolved (`pip download torch==<ver>+cu126 --index-url
# https://download.pytorch.org/whl/cu126 --no-deps` and read off the
# resulting filename/URL) to match, or GPU mode will just keep downloading
# a mismatched pair that fails to import.
TORCH_CUDA_DIR = GPU_RUNTIME_DIR / "torch-cuda"
TORCH_CUDA_MARKER = TORCH_CUDA_DIR / ".installed"
TORCH_CUDA_WHEELS = [
    (
        "torch-2.13.0+cu126-cp312-cp312-win_amd64.whl",
        "https://download.pytorch.org/whl/cu126/torch-2.13.0%2Bcu126-cp312-cp312-win_amd64.whl",
    ),
    (
        "torchvision-0.28.0+cu126-cp312-cp312-win_amd64.whl",
        "https://download.pytorch.org/whl/cu126/torchvision-0.28.0%2Bcu126-cp312-cp312-win_amd64.whl",
    ),
]


def is_torch_cuda_installed() -> bool:
    return TORCH_CUDA_MARKER.is_file()


def torch_cuda_sys_path() -> str | None:
    """Directory to prepend to sys.path so `import torch`/`import
    torchvision` resolve to the CUDA build instead of the bundled CPU one —
    or None if it isn't installed. Caller (backend/main.py) must insert this
    before literally anything in the process has imported torch."""
    return str(TORCH_CUDA_DIR) if is_torch_cuda_installed() else None


def is_gpu_enabled_setting() -> bool:
    """Reads AppSettings.gpu_enabled straight out of the sqlite file via the
    stdlib sqlite3 module rather than the app's own ORM/session — this gets
    called at the very top of backend/main.py, before backend.database (and
    the rest of the app) exists yet."""
    import sqlite3
    db_path = os.path.join(DATA_DIR, "raccoonhouse.db")
    if not os.path.isfile(db_path):
        return False
    try:
        con = sqlite3.connect(db_path)
        row = con.execute("SELECT gpu_enabled FROM app_settings WHERE id = 1").fetchone()
        con.close()
        return bool(row and row[0])
    except Exception:
        return False


def install_torch_cuda(on_progress=None) -> None:
    """Downloads the CUDA torch+torchvision wheels (~2.5GB combined) and
    unpacks them (a .whl is just a zip archive) into a standalone directory —
    no pip involved, since the frozen exe has no general Python interpreter
    to shell out to."""
    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    TORCH_CUDA_DIR.mkdir(parents=True, exist_ok=True)
    n = len(TORCH_CUDA_WHEELS)
    for i, (filename, url) in enumerate(TORCH_CUDA_WHEELS):
        base = int(i / n * 90)
        span = 90 // n
        progress(base, f"Завантаження {filename}…")
        wheel_path = TORCH_CUDA_DIR / filename
        request = Request(url, headers={"User-Agent": "RaccoonHouse-Studio"})
        with urlopen(request, timeout=30) as resp:
            total = int(resp.headers.get("Content-Length", 0)) or 1
            downloaded = 0
            with open(wheel_path, "wb") as f:
                while True:
                    chunk = resp.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    progress(base + int(downloaded / total * span), f"Завантаження {filename}…")

        progress(base + span, f"Розпакування {filename}…")
        with zipfile.ZipFile(wheel_path) as zf:
            zf.extractall(TORCH_CUDA_DIR)
        wheel_path.unlink(missing_ok=True)

    TORCH_CUDA_MARKER.write_text("ok")
    progress(100, "GPU-прискорення для всіх моделей встановлено")
