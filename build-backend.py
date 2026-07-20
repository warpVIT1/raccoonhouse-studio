"""
Build script: packages the Python backend into a standalone app folder using
PyInstaller.
Run: python build-backend.py
Output: backend-dist/raccoonhouse-backend/raccoonhouse-backend.exe
"""
import os
import shutil
import subprocess
import sys

def main():
    print("Building Python backend with PyInstaller...")

    project_root = os.path.dirname(os.path.abspath(__file__))
    backend_src = os.path.join(project_root, "backend")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        # --onedir, not --onefile: the CUDA runtime (onnxruntime-gpu's
        # provider DLL + nvidia-*-cu12 packages, ~2.5GB) is downloaded on
        # demand into this same folder tree instead of being bundled (see
        # gpu_runtime_service.py) — that only works with a stable,
        # persistent app directory. A onefile exe re-extracts to a fresh
        # temp directory on every launch, which would mean re-downloading
        # gigabytes on every single startup.
        "--onedir",
        "--name", "raccoonhouse-backend",
        "--distpath", "backend-dist",
        "--workpath", "build-pyinstaller",
        "--specpath", "build-pyinstaller",
        "--hidden-import", "uvicorn.logging",
        "--hidden-import", "uvicorn.loops",
        "--hidden-import", "uvicorn.loops.auto",
        "--hidden-import", "uvicorn.protocols",
        "--hidden-import", "uvicorn.protocols.http",
        "--hidden-import", "uvicorn.protocols.http.auto",
        "--hidden-import", "uvicorn.protocols.websockets",
        "--hidden-import", "uvicorn.protocols.websockets.auto",
        "--hidden-import", "uvicorn.lifespan",
        "--hidden-import", "uvicorn.lifespan.on",
        "--hidden-import", "sqlalchemy.dialects.sqlite",
        "--hidden-import", "audio_separator",
        "--hidden-import", "silero_vad",
        "--hidden-import", "soundfile",
        "--hidden-import", "librosa",
        "--collect-all", "audio_separator",
        "--collect-all", "silero_vad",
        # onnxruntime's CPU pieces (onnxruntime.dll, provider bridge, Python
        # bindings) ship in the installer so CPU mode always works out of the
        # box. The CUDA provider DLL itself (~712MB) is deliberately EXCLUDED
        # below — GPU support is opt-in and downloaded on demand (see
        # gpu_runtime_service.py) rather than bundled, to keep the installer
        # small. Do NOT add nvidia_cublas_cu12/nvidia_cudnn_cu12/
        # nvidia_cuda_runtime_cu12/nvidia_cufft_cu12 collect-all here — same
        # reason, they're downloaded into the app's userData dir instead.
        "--collect-all", "onnxruntime",
        # Simply not adding --collect-all for the nvidia-*-cu12 packages
        # above is NOT enough — onnxruntime's own code imports nvidia.cublas
        # etc. in a try/except at module load (probing for a usable CUDA lib
        # location), and PyInstaller's static import analysis follows that
        # unconditionally, pulling in the whole ~1.8GB nvidia/ tree anyway
        # (confirmed live 2026-07-19: backend-dist ballooned right back up
        # despite no explicit collect-all for it). Excluding the module
        # outright is the only way to actually keep it out — safe here since
        # nothing in the CPU-only code path ever needs it at runtime; GPU
        # mode gets it from gpu_runtime_service.py's download instead.
        "--exclude-module", "nvidia",
        "--exclude-module", "nvidia_cublas_cu12",
        "--exclude-module", "nvidia_cudnn_cu12",
        "--exclude-module", "nvidia_cuda_runtime_cu12",
        "--exclude-module", "nvidia_cufft_cu12",
        "--exclude-module", "nvidia_cuda_nvrtc_cu12",
        "--exclude-module", "nvidia_nvjitlink_cu12",
        # Absolute source path: PyInstaller resolves relative --add-data paths against
        # --specpath, not the invocation cwd, so a relative "backend" here would
        # (and did) resolve to build-pyinstaller/backend and fail to be found.
        "--add-data", f"{backend_src}{os.pathsep}backend",
        os.path.join(project_root, "backend", "main.py"),
    ]

    result = subprocess.run(cmd)
    if result.returncode != 0:
        print("Build failed!", file=sys.stderr)
        sys.exit(1)

    # onnxruntime's CUDA provider DLL got pulled in by --collect-all
    # onnxruntime (it ships inside the onnxruntime-gpu package alongside the
    # CPU pieces we DO want) — strip it back out so the installer doesn't
    # silently balloon back up to the size this whole on-demand-download
    # scheme exists to avoid. gpu_runtime_service.py downloads this exact
    # file back into the same location when the user opts into GPU mode.
    cuda_provider_dll = os.path.join(
        project_root, "backend-dist", "raccoonhouse-backend", "_internal",
        "onnxruntime", "capi", "onnxruntime_providers_cuda.dll",
    )
    if os.path.isfile(cuda_provider_dll):
        os.remove(cuda_provider_dll)
        print(f"Stripped bundled CUDA provider DLL: {cuda_provider_dll}")

    print("Backend built successfully: backend-dist/raccoonhouse-backend/raccoonhouse-backend.exe")

if __name__ == "__main__":
    main()
