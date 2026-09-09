"""
On-demand audio-separator library updates — lets the admin push a newer
audio-separator (the Python separation library, pinned in requirements.txt
and frozen into the PyInstaller build) to every install without shipping a
new RaccoonHouse app version, mirroring gpu_runtime_service.py's
torch_cuda_sys_path() pattern: download the wheel (a .whl is just a zip),
extract it into a persistent directory under RH_DATA_DIR, and sys.path-swap
it in ahead of the bundled copy before anything imports audio_separator.

Only swaps the audio_separator package itself, NOT its dependencies (numpy/
scipy/librosa/soundfile/torch/onnxruntime etc, which audio-separator pulls
in transitively per requirements.txt's own comment) — same trade-off as the
torch CUDA wheel swap. If a newer audio-separator version needs a newer
transitive dependency that isn't already bundled, imports can fail at
runtime. There's no automated compatibility check for this — whoever
publishes a version via push_recommended_version() is expected to have
already run it locally first. Never automatic: a user only downloads a
pushed version after clicking through Settings (see routers/settings.py).
"""
import os
import time
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

# requests + discovery_service are imported lazily inside the functions that
# need them, not here — this module is imported very early in main.py
# (before the sys.path swap below even runs), same constraint as
# gpu_runtime_service.py, and discovery_service pulls in SQLAlchemy/models/
# database transitively (via power_share_service), which has no business
# being forced that early.

# Must match requirements.txt's audio-separator pin exactly — this is what
# "no update available" compares the remote recommended version against
# when nothing has been downloaded into LIB_RUNTIME_DIR yet.
BUNDLED_VERSION = "0.44.3"

DATA_DIR = os.environ.get("RH_DATA_DIR", os.path.join(os.path.expanduser("~"), ".raccoonhouse"))
LIB_RUNTIME_DIR = Path(DATA_DIR) / "lib-runtime" / "audio-separator"
ACTIVE_MARKER = LIB_RUNTIME_DIR / ".active_version"

_remote_cache: "dict | None" = None
_remote_cache_at = 0.0
_REMOTE_CACHE_TTL = 600  # 10 min — same reasoning as has_nvidia_gpu()'s cache: /settings can be polled repeatedly


def installed_version() -> "str | None":
    """The version currently swapped in via sys.path, or None if the bundled
    (requirements.txt-pinned) copy is what's active."""
    if ACTIVE_MARKER.is_file():
        return ACTIVE_MARKER.read_text().strip() or None
    return None


def active_version() -> str:
    return installed_version() or BUNDLED_VERSION


def audio_separator_sys_path() -> "str | None":
    """Directory to prepend to sys.path so `import audio_separator` resolves
    to the downloaded version instead of the bundled one — or None if
    nothing's been downloaded. Caller (backend/main.py) must insert this
    before literally anything in the process has imported audio_separator
    (which separator_service.py does at module level)."""
    v = installed_version()
    return str(LIB_RUNTIME_DIR / v) if v else None


def fetch_remote_recommended(force: bool = False) -> "dict | None":
    """{"version": "...", "wheel_url": "..."} as last published via
    push_recommended_version(), or None if nothing's been published (or the
    Worker is unreachable/online signaling is disabled). Cached — see
    _REMOTE_CACHE_TTL."""
    global _remote_cache, _remote_cache_at
    if not force and _remote_cache is not None and (time.time() - _remote_cache_at) < _REMOTE_CACHE_TTL:
        return _remote_cache
    import requests
    from . import discovery_service
    base = discovery_service.get_https_base()
    if not base:
        return _remote_cache
    try:
        resp = requests.get(f"{base}/audio-separator-version", timeout=8)
        data = resp.json()
        _remote_cache = data if isinstance(data, dict) and data.get("version") else None
        _remote_cache_at = time.time()
        return _remote_cache
    except Exception:
        # Network hiccups shouldn't surface as "no update" permanently — only
        # cache successful checks, same reasoning as has_nvidia_gpu()'s retry.
        return _remote_cache


def update_available() -> "dict | None":
    """The remote-recommended version if it differs from whatever's active
    locally right now, else None."""
    remote = fetch_remote_recommended()
    if not remote:
        return None
    if remote["version"] == active_version():
        return None
    return remote


def install_version(version: str, wheel_url: str, on_progress=None) -> None:
    """Downloads the audio_separator wheel and unpacks it (a .whl is just a
    zip archive) into its own version-tagged directory — no pip involved,
    since the frozen exe has no general Python interpreter to shell out to.
    Takes effect on next launch (sys.path swap happens once, at process
    start in main.py — same as GPU runtime)."""
    def progress(pct, msg):
        if on_progress:
            on_progress(pct, msg)

    target_dir = LIB_RUNTIME_DIR / version
    target_dir.mkdir(parents=True, exist_ok=True)

    filename = wheel_url.rsplit("/", 1)[-1] or f"audio_separator-{version}.whl"
    wheel_path = target_dir / filename
    progress(0, f"Завантаження {filename}…")
    request = Request(wheel_url, headers={"User-Agent": "RaccoonHouse-Studio"})
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
                progress(int(downloaded / total * 90), f"Завантаження {filename}…")

    progress(92, "Розпакування…")
    with zipfile.ZipFile(wheel_path) as zf:
        zf.extractall(target_dir)
    wheel_path.unlink(missing_ok=True)

    ACTIVE_MARKER.write_text(version)
    progress(100, f"audio-separator {version} встановлено — потрібен перезапуск програми")


def push_recommended_version(version: str, wheel_url: str) -> None:
    """Publishes a new recommended version to the Worker — every install's
    next Settings check (see update_available()) picks it up, no app update
    needed. Admin-gated at the router level (see routers/settings.py), not
    here, same as discovery_service.push_apex_models. Unlike that function
    this DOES raise on failure — this is the primary action, not a
    best-effort side effect of an already-successful local save, so the
    admin needs to know if it didn't actually publish."""
    global _remote_cache, _remote_cache_at
    import requests
    from . import discovery_service
    base = discovery_service.get_https_base()
    if not base:
        raise RuntimeError("Онлайн-синхронізація вимкнена або недоступна")
    resp = requests.put(f"{base}/audio-separator-version", json={"version": version, "wheel_url": wheel_url}, timeout=15)
    resp.raise_for_status()
    _remote_cache = {"version": version, "wheel_url": wheel_url}
    _remote_cache_at = time.time()
