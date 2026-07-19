"""
Peer discovery for power-sharing, two ways:
  1. Automatic LAN discovery — every instance periodically broadcasts a UDP
     announcement and listens for others'. Works out of the box on a real LAN.
  2. Manual direct-connect fallback — for two PCs that AREN'T on the same LAN
     (a friend at a different location) or connected through a VPN mesh
     (Hamachi/Radmin/ZeroTier) that doesn't relay broadcast/multicast traffic
     the way a real LAN switch does. One side pins the other's address in
     Settings; a plain HTTP poll (not UDP) merges it into the same registry
     as if it had been broadcast-discovered.
"""
import json
import socket
import threading
import time
import uuid

import requests

from .gpu_service import get_gpu_info
from .power_share_service import power_logger, peer_base_url

MANUAL_POLL_INTERVAL_SECONDS = 3

DISCOVERY_PORT = 48765
BROADCAST_INTERVAL_SECONDS = 3
STALE_AFTER_SECONDS = 12

# A random ID generated fresh per process, included in every broadcast, is how
# each instance recognizes (and excludes) its own announcement — comparing IP
# addresses for this is NOT reliable: a machine with a VPN/virtual adapter
# (Hamachi, Radmin, etc.) can have the OS send the broadcast from a different
# adapter/IP than the one a "connect out to 8.8.8.8" trick reports as "mine",
# so an IP-based self-check can silently fail to exclude yourself.
_instance_id = str(uuid.uuid4())

_registry: dict[str, dict] = {}  # instance_id -> {host, port, name, ...}
_registry_lock = threading.Lock()
_started = False

_state_provider = None  # callable returning current (name, power_share_enabled, logged_in)
_manual_peer_provider = None  # callable returning current (host, port) or (None, None)


def set_state_provider(fn):
    """fn() -> (profile_name: str, power_share_enabled: bool, logged_in: bool)"""
    global _state_provider
    _state_provider = fn


def set_manual_peer_provider(fn):
    """fn() -> (host: str | None, port: int) — the pinned direct-connect address
    configured in Settings, or (None, _) if none is set."""
    global _manual_peer_provider
    _manual_peer_provider = fn


def get_discovered_peers() -> list[dict]:
    now = time.time()
    with _registry_lock:
        return [
            info for info in _registry.values()
            if now - info["last_seen"] <= STALE_AFTER_SECONDS
        ]


def start(backend_port: int):
    global _started
    if _started:
        return
    _started = True
    gpu = get_gpu_info()
    threading.Thread(target=_broadcast_loop, args=(backend_port, gpu), daemon=True).start()
    threading.Thread(target=_listen_loop, args=(backend_port,), daemon=True).start()
    threading.Thread(target=_manual_peer_poll_loop, daemon=True).start()
    power_logger.info("Discovery started id=%s (gpu=%s, %.1f GB)", _instance_id[:8], gpu["name"], gpu["vram_gb"])


def _manual_peer_poll_loop():
    """Polls the one pinned direct-connect address (if configured) over plain
    HTTP and merges it into the same registry as LAN-discovered peers — this
    is what makes power-sharing work between two PCs that broadcast can't
    reach at all (different networks, or a non-relaying VPN mesh)."""
    while True:
        try:
            host, port = _manual_peer_provider() if _manual_peer_provider else (None, 8765)
            if host:
                key = f"manual:{host}:{port}"
                try:
                    resp = requests.get(f"{peer_base_url(host, port)}/api/power-share/status", timeout=4)
                    resp.raise_for_status()
                    data = resp.json()
                    with _registry_lock:
                        is_new = key not in _registry
                        _registry[key] = {
                            "host": host,
                            "port": port,
                            "name": data.get("name", "?"),
                            "power_share_enabled": bool(data.get("power_share_enabled")),
                            "logged_in": bool(data.get("logged_in")),
                            "gpu_name": data.get("gpu_name", "Невідома відеокарта"),
                            "vram_gb": data.get("vram_gb", 0.0),
                            "last_seen": time.time(),
                        }
                    if is_new:
                        power_logger.info("Manual peer connected host=%s:%s name=%s", host, port, data.get("name"))
                except Exception as exc:
                    power_logger.info("Manual peer unreachable host=%s:%s error=%s", host, port, exc)
        except Exception:
            pass
        time.sleep(MANUAL_POLL_INTERVAL_SECONDS)


def _broadcast_loop(backend_port: int, gpu: dict):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    while True:
        try:
            name, power_share_enabled, logged_in = (
                _state_provider() if _state_provider else ("?", False, False)
            )
            payload = json.dumps({
                "type": "raccoonhouse_announce",
                "instance_id": _instance_id,
                "port": backend_port,
                "name": name,
                "power_share_enabled": power_share_enabled,
                "logged_in": logged_in,
                "gpu_name": gpu["name"],
                "vram_gb": gpu["vram_gb"],
            }).encode("utf-8")
            sock.sendto(payload, ("255.255.255.255", DISCOVERY_PORT))
        except Exception:
            pass
        time.sleep(BROADCAST_INTERVAL_SECONDS)


def _listen_loop(backend_port: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("", DISCOVERY_PORT))
    except OSError:
        power_logger.info("Discovery listen failed — port %s already in use", DISCOVERY_PORT)
        return
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            msg = json.loads(data.decode("utf-8"))
            if msg.get("type") != "raccoonhouse_announce":
                continue
            peer_id = msg.get("instance_id")
            if not peer_id or peer_id == _instance_id:
                continue  # our own broadcast, looped back by the OS/router
            host = addr[0]
            port = msg.get("port", backend_port)
            with _registry_lock:
                is_new = peer_id not in _registry
                _registry[peer_id] = {
                    "host": host,
                    "port": port,
                    "name": msg.get("name", "?"),
                    "power_share_enabled": bool(msg.get("power_share_enabled")),
                    "logged_in": bool(msg.get("logged_in")),
                    "gpu_name": msg.get("gpu_name", "Невідома відеокарта"),
                    "vram_gb": msg.get("vram_gb", 0.0),
                    "last_seen": time.time(),
                }
            if is_new:
                power_logger.info("Discovered peer host=%s port=%s name=%s", host, port, msg.get("name"))
        except Exception:
            pass
