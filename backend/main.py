"""
RaccoonHouse Studio — FastAPI backend.
Spawned by Electron main process on app launch.
Listens on localhost:8765 (port configurable via --port).
"""
import argparse
import asyncio
import os
import sys
from contextlib import asynccontextmanager
from typing import Set

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# Make sure the package root is importable when run directly (python backend/main.py)
if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# onnxruntime-gpu's CUDAExecutionProvider dynamically LoadLibrary()s
# cublas64_12.dll/cudnn64_9.dll at runtime — nothing else in this process ever
# imports the nvidia-cublas-cu12/nvidia-cudnn-cu12 packages that ship those
# DLLs (torch here is the plain CPU build, see requirements.txt, so it never
# registers a CUDA lib directory the way a CUDA-enabled torch build would),
# so without this, onnxruntime silently falls back to CPU ("No hardware
# acceleration could be configured" in the separator log) even with both
# packages installed. Must run before anything imports onnxruntime — done
# here, at the top of the entrypoint, before any router/service import.
if sys.platform == "win32":
    try:
        import nvidia.cublas
        import nvidia.cudnn
        # nvidia.cublas/nvidia.cudnn are native (PEP 420) namespace packages —
        # they have no __init__.py, so __file__ is None; __path__ is the only
        # way to find where their DLLs actually live.
        os.add_dll_directory(os.path.join(list(nvidia.cublas.__path__)[0], "bin"))
        os.add_dll_directory(os.path.join(list(nvidia.cudnn.__path__)[0], "bin"))
    except Exception:
        pass  # no NVIDIA GPU packages installed / not on an NVIDIA machine — CPU fallback is fine

from backend.database import init_db, SessionLocal
from backend import job_manager
from backend.routers import titles, episodes, characters, subtitles, markers, jobs, settings, hikka, profiles, power_share
from backend.services.ffmpeg_service import get_waveform_samples
from backend.services import discovery_service
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


def _manual_peer_config():
    db = SessionLocal()
    try:
        s = db.get(AppSettings, 1)
        if not s or not s.manual_peer_host:
            return None, 8765
        return s.manual_peer_host, s.manual_peer_port
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    job_manager.set_broadcast(broadcast)
    discovery_service.set_state_provider(_discovery_state)
    discovery_service.set_manual_peer_provider(_manual_peer_config)
    discovery_service.start(int(os.environ.get("RH_BACKEND_PORT", "8765")))
    yield


app = FastAPI(title="RaccoonHouse Studio API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    # 0.0.0.0 by default so the optional power-sharing feature can reach this
    # machine over LAN — power-share endpoints themselves stay inert unless the
    # user explicitly turns the feature on in Settings (off by default).
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=False,
    )
