"""
RaccoonHouse Studio — FastAPI backend.
Spawned by Electron main process on app launch.
Listens on localhost:8765 (port configurable via --port).
"""
import argparse
import asyncio
import os
import sys
import time
from contextlib import asynccontextmanager
from typing import Set

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Make sure the package root is importable when run directly (python backend/main.py)
if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# audio-separator (a third-party library, not ours) runs its own internal
# `subprocess.check_output(["ffmpeg", "-version"])` sanity check the moment a
# Separator() is instantiated — by bare name, relying on ffmpeg being on
# PATH. Our own ffmpeg_service.py resolves the bundled resources/bin/ffmpeg.exe
# by full path for our own subprocess calls (see _ffmpeg_bin()), but that does
# nothing for a subprocess call INSIDE a dependency we don't control. On any
# machine without ffmpeg installed system-wide — which is exactly the point
# of bundling our own, so users never have to — this made every single
# separation attempt fail immediately with FileNotFoundError, before any
# model even loaded. Putting the bundled dir on PATH once at startup fixes
# this for every subprocess call in the process, ours and third-party alike.
_resources_dir = os.environ.get("RH_RESOURCES_DIR")
if _resources_dir and os.path.isdir(_resources_dir):
    os.environ["PATH"] = _resources_dir + os.pathsep + os.environ.get("PATH", "")

# GPU acceleration is opt-in (Settings → gpu_enabled) and, when enabled,
# needs torch's CUDA build swapped in ahead of the plain CPU one that's
# always bundled — see gpu_runtime_service.py's long comment on why this
# can't be done the same lightweight way as onnxruntime's CUDA provider.
# Must run here, before ANY of the router/service imports below (several of
# which import torch transitively) — once something has imported torch, a
# later sys.path change can't undo that.
from backend.services import gpu_runtime_service
if gpu_runtime_service.is_gpu_enabled_setting() and gpu_runtime_service.is_torch_cuda_installed():
    sys.path.insert(0, gpu_runtime_service.torch_cuda_sys_path())

# onnxruntime-gpu's CUDAExecutionProvider is a genuine plugin DLL, loaded by
# name at runtime rather than needing a sys.path swap — handled per-job, in
# separator_service.py's _patch_separator_gpu_detection(), since it only
# needs to run right before a Separator() gets instantiated, not this early.

from backend.database import init_db, SessionLocal
from backend import job_manager
from backend.routers import titles, episodes, characters, subtitles, markers, jobs, settings, hikka, profiles, power_share
from backend.services.ffmpeg_service import get_waveform_samples
from backend.services import discovery_service
from backend.services.power_share_service import app_logger
from backend.models import AppSettings, Profile
from backend.schemas import WaveformResponse


# --- WebSocket broadcast ---
ws_clients: Set[WebSocket] = set()


async def broadcast(data: dict):
    dead: set[WebSocket] = set()
    for ws in ws_clients:
        try:
            await ws.send_json(data)
        except Exception:
            dead.add(ws)
    ws_clients.difference_update(dead)


def _discovery_state():
    db = SessionLocal()
    try:
        s = db.get(AppSettings, 1)
        if not s:
            return "?", False, False
        name = "?"
        if s.active_profile_id:
            profile = db.get(Profile, s.active_profile_id)
            if profile:
                name = profile.name
        return name, bool(s.power_share_enabled), bool(s.active_profile_id)
    finally:
        db.close()


def _online_signaling_config():
    db = SessionLocal()
    try:
        s = db.get(AppSettings, 1)
        if not s or not s.online_signaling_enabled or not s.online_signaling_url:
            return False, None
        return True, s.online_signaling_url
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    job_manager.set_broadcast(broadcast)
    discovery_service.set_state_provider(_discovery_state)
    discovery_service.set_online_signaling_provider(_online_signaling_config)
    discovery_service.set_broadcast(asyncio.get_event_loop(), job_manager._ws_broadcast)
    discovery_service.start(int(os.environ.get("RH_BACKEND_PORT", "8765")))
    yield


app = FastAPI(title="RaccoonHouse Studio API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_all_requests(request: Request, call_next):
    # Single choke point every single HTTP request passes through — logging
    # here (rather than scattering a log call into every router function)
    # guarantees complete coverage, including routers nobody's gotten around
    # to instrumenting individually and any added later. /health and /ws are
    # excluded: /health is polled continuously by the frontend's backend-ready
    # check and would otherwise drown app.log in noise within minutes.
    if request.url.path in ("/health",):
        return await call_next(request)

    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        # The generic exception_handler below also logs this same traceback
        # for the HTTP response it sends back — this duplicate catch is only
        # to record the timing/path before re-raising, not to swallow it.
        elapsed_ms = (time.monotonic() - start) * 1000
        app_logger.exception("%s %s -> EXCEPTION (%.0fms)", request.method, request.url.path, elapsed_ms)
        raise
    elapsed_ms = (time.monotonic() - start) * 1000
    log_fn = app_logger.warning if response.status_code >= 400 else app_logger.info
    log_fn("%s %s -> %s (%.0fms)", request.method, request.url.path, response.status_code, elapsed_ms)
    return response


@app.exception_handler(Exception)
async def log_unhandled_exception(request: Request, exc: Exception):
    # Without this, an unhandled exception in any endpoint just becomes a
    # bare 500 with no trace anywhere the user could actually send us — the
    # packaged app has no visible console, so uvicorn's default stderr
    # logging is otherwise unrecoverable. logger.exception() captures the
    # full traceback into app.log, which a user CAN attach to a report.
    app_logger.exception("UNHANDLED %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Internal Server Error"})

# Register routers under /api prefix
app.include_router(titles.router, prefix="/api")
app.include_router(episodes.router, prefix="/api")
app.include_router(characters.router, prefix="/api")
app.include_router(subtitles.router, prefix="/api")
app.include_router(markers.router, prefix="/api")
app.include_router(jobs.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(hikka.router, prefix="/api")
app.include_router(profiles.router, prefix="/api")
app.include_router(power_share.router, prefix="/api")


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        while True:
            # Keep-alive — client can send pings
            data = await ws.receive_text()
            if data == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        ws_clients.discard(ws)
    except Exception:
        ws_clients.discard(ws)


@app.get("/api/waveform", response_model=WaveformResponse)
def get_waveform(path: str, samples: int = 2000):
    if not os.path.isfile(path):
        return WaveformResponse(samples=[], duration=0.0, sample_rate=48000)
    result, duration, sr = get_waveform_samples(path, samples)
    return WaveformResponse(samples=result, duration=duration, sample_rate=sr)


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    # Loopback only — Power Share no longer accepts direct inbound connections
    # from other PCs (everything routes through the Cloudflare signaling
    # Worker instead, see backend/services/discovery_service.py), so nothing
    # needs this machine's local API reachable from the LAN anymore.
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=False,
    )
