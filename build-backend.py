"""
Build script: packages the Python backend into a standalone exe using PyInstaller.
Run: python build-backend.py
Output: backend-dist/raccoonhouse-backend.exe
"""
import os
import subprocess
import sys

def main():
    print("Building Python backend with PyInstaller...")

    project_root = os.path.dirname(os.path.abspath(__file__))
    backend_src = os.path.join(project_root, "backend")

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--onefile",
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
        # GPU support: onnxruntime-gpu's CUDA provider DLL and the
        # nvidia-cublas-cu12/nvidia-cudnn-cu12 runtime DLLs it depends on are
        # loaded dynamically at runtime (not via a Python import PyInstaller's
        # static analysis can see), so they need to be forced in explicitly —
        # otherwise the packaged exe silently falls back to CPU even though
        # the dev environment (which just has them on disk in site-packages,
        # not frozen) has GPU acceleration working fine. torch is plain CPU
        # here (see requirements.txt) so these are the only source of CUDA
        # runtime DLLs in this build.
        "--collect-all", "onnxruntime",
        "--collect-all", "nvidia_cublas_cu12",
        "--collect-all", "nvidia_cudnn_cu12",
        # Absolute source path: PyInstaller resolves relative --add-data paths against
        # --specpath, not the invocation cwd, so a relative "backend" here would
        # (and did) resolve to build-pyinstaller/backend and fail to be found.
        "--add-data", f"{backend_src}{os.pathsep}backend",
        os.path.join(project_root, "backend", "main.py"),
    ]

    result = subprocess.run(cmd)
    if result.returncode == 0:
        print("Backend built successfully: backend-dist/raccoonhouse-backend.exe")
    else:
        print("Build failed!", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
