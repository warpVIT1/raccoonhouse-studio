"""
Auto-installs backend/requirements.txt into whatever Python is about to run
the backend, the first time any of them turns out to be missing.

Deliberately has ZERO third-party imports (stdlib only) — it has to run
before anything in requirements.txt is guaranteed to exist, and importing the
`backend` package itself is safe (backend/__init__.py is empty) but anything
beyond stdlib is not.

Why this exists: in dev, electron/main.ts spawns the backend with the
project's own .venv Python if `.venv` exists, otherwise falls back to a bare
`python`/`python3` off PATH (see its comment there). A fresh clone/checkout —
or any machine where `.venv` was never created — has neither, so the backend
process used to just die on the very first `import fastapi` (or whatever
happened to be missing), which from the Electron/UI side was indistinguishable
from vocal isolation (or anything else) simply "not starting": no dialog, no
log a normal user would think to look at, just a spinner that quietly stops.

CRITICAL: this must use importlib.util.find_spec(), never
importlib.import_module() (or any bare `import`), to check for a package's
presence. find_spec() locates a module without executing it, so it never
touches sys.modules. Actually importing torch/torchvision here — as an
earlier version of this file did — permanently caches whichever build sys.path
resolves to at THIS early point (before backend/main.py's own
gpu_runtime_service sys.path swap for GPU mode ever runs). A later
sys.path.insert(0, ...) has no effect on an already-imported module, so torch
would stay the plain CPU build while torchvision (imported for the first time
later, deep inside audio-separator's model loading) would resolve fresh
against the swapped path to the CUDA build — two mismatched builds loaded at
once, which surfaced live as "RuntimeError: operator torchvision::nms does
not exist" the moment vocal separation actually ran with GPU mode enabled.
See gpu_runtime_service.py's torch_cuda_sys_path() docstring for the same
invariant stated from the other side.
"""
import importlib.util
import os
import subprocess
import sys

# One representative top-level import name per requirements.txt entry (a few
# packages install under a different import name than their PyPI name, e.g.
# python-multipart -> "multipart" — this list uses the actual importable
# names). Checking these is enough to catch "nothing installed" or "half
# installed" without spending time re-checking every single dependency.
_PROBE_MODULES = [
    "requests", "fastapi", "uvicorn", "websockets", "aiofiles", "multipart",
    "sqlalchemy", "alembic", "pydantic", "pydantic_settings", "silero_vad",
    "audio_separator", "torch", "onnxruntime", "soundfile", "librosa",
]


def ensure_dependencies() -> None:
    """No-op in a packaged (PyInstaller) build — that already bundles every
    dependency, and pip may not even be available/writable next to a frozen
    exe. Only relevant when running from source (dev mode)."""
    if getattr(sys, "frozen", False):
        return

    missing = []
    for name in _PROBE_MODULES:
        try:
            found = importlib.util.find_spec(name) is not None
        except (ImportError, ValueError):
            # find_spec() itself can raise ImportError for a namespace
            # package edge case, or ValueError if a stale/broken .dist-info
            # confuses the finder — either way, treat as "not resolvable".
            found = False
        if not found:
            missing.append(name)

    if not missing:
        return

    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    req_file = os.path.join(project_root, "backend", "requirements.txt")

    print(
        f"[bootstrap_deps] Missing Python packages detected: {', '.join(missing)} — "
        f"installing {req_file} into {sys.executable} …",
        flush=True,
    )
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", req_file],
        cwd=project_root,
    )
    if result.returncode != 0:
        print(
            f"[bootstrap_deps] pip install exited with code {result.returncode} — "
            f"the backend will likely fail to start until this is resolved manually "
            f"(run: {sys.executable} -m pip install -r \"{req_file}\").",
            file=sys.stderr, flush=True,
        )
    else:
        print("[bootstrap_deps] Dependency install complete.", flush=True)
