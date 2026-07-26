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
        "--noconfirm",
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
        # librosa's optional resampling backends — only imported lazily
        # inside a code path VR Arch models hit (which one depends on the
        # input's actual sample rate). A plain --hidden-import isn't enough
        # for either: samplerate is CFFI-based (needs its compiled
        # extension + data bundled, not just the import recognized) and
        # resampy has its own PyInstaller hook that only grabbed its data/
        # filter-coefficients folder, not the actual .py source, when only
        # hidden-imported (confirmed live 2026-07-26 — _internal/resampy
        # existed but contained nothing but a data/ subfolder, and
        # _internal/samplerate didn't exist at all). --collect-all forces
        # the whole package in, same as audio_separator/silero_vad above.
        "--collect-all", "samplerate",
        "--collect-all", "resampy",
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

    # onnxruntime-gpu ships its CUDA provider DLL AND a pile of cuBLAS/cuDNN/
    # cuFFT/cudart/nvrtc/nvJitLink DLLs directly inside onnxruntime/capi/
    # alongside the CPU pieces we DO want — --collect-all onnxruntime pulls
    # in all of it. Strip every NVIDIA-runtime DLL back out so the installer
    # doesn't silently balloon back up to ~2GB (confirmed live 2026-07-21:
    # deleting only onnxruntime_providers_cuda.dll left cublasLt/cudnn/cufft/
    # nvrtc etc. behind, still ~2.4GB). gpu_runtime_service.py's
    # ensure_gpu_provider_placed() hardlinks this exact same set of files
    # back into this directory when the user opts into GPU mode — match its
    # file set here, not just the one provider DLL, and match by pattern
    # (not a fixed filename list) since exact cuDNN/CUDA version suffixes in
    # these names shift with onnxruntime-gpu version bumps.
    capi_dir = os.path.join(
        project_root, "backend-dist", "raccoonhouse-backend", "_internal",
        "onnxruntime", "capi",
    )
    NVIDIA_RUNTIME_PATTERNS = (
        "cublas", "cudnn", "cufft", "cudart", "nvrtc", "nvjitlink", "nvblas",
        "providers_cuda", "providers_tensorrt",
    )
    if os.path.isdir(capi_dir):
        freed = 0
        stripped = []
        for name in os.listdir(capi_dir):
            if any(p in name.lower() for p in NVIDIA_RUNTIME_PATTERNS):
                path = os.path.join(capi_dir, name)
                freed += os.path.getsize(path)
                os.remove(path)
                stripped.append(name)
        if stripped:
            print(f"Stripped {len(stripped)} bundled NVIDIA runtime DLLs ({freed / 1e9:.2f} GB): {', '.join(stripped)}")

    print("Backend built successfully: backend-dist/raccoonhouse-backend/raccoonhouse-backend.exe")

if __name__ == "__main__":
    main()
