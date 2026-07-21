"""
Peer discovery for power-sharing, three ways:
  1. Automatic LAN discovery — every instance periodically broadcasts a UDP
     announcement and listens for others'. Works out of the box on a real LAN.
  2. Manual direct-connect fallback — for two PCs that AREN'T on the same LAN
     (a friend at a different location) or connected through a VPN mesh
     (Hamachi/Radmin/ZeroTier) that doesn't relay broadcast/multicast traffic
     the way a real LAN switch does. One side pins the other's address in
     Settings; a plain HTTP poll (not UDP) merges it into the same registry
     as if it had been broadcast-discovered.
  3. Online signaling — for two PCs with no LAN/VPN-mesh path between them at
     all. A small Cloudflare Worker (see cloudflare-signaling/) tracks who's
     currently connected and each one's public IP (which it learns from the
     connection itself — no self-IP-detection needed client-side) and pushes
     the live peer list over a persistent WebSocket. The actual separation
     job's file upload still goes directly PC-to-PC over plain HTTP; the
     Worker only ever sees "who's online" plus tiny consent messages.
"""
import json
import socket
import threading
import time
import uuid

import requests
from websockets.sync.client import connect as ws_connect
from websockets.exceptions import WebSocketException

from .gpu_service import get_gpu_info
from .power_share_service import power_logger, peer_base_url

MANUAL_POLL_INTERVAL_SECONDS = 3
ONLINE_SIGNALING_HEARTBEAT_SECONDS = 5
ONLINE_SIGNALING_RECONNECT_SECONDS = 5

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
_online_signaling_provider = None  # callable returning current (enabled, url)


def set_state_provider(fn):
    """fn() -> (profile_name: str, power_share_enabled: bool, logged_in: bool)"""
    global _state_provider
    _state_provider = fn


def set_manual_peer_provider(fn):
    """fn() -> (host: str | None, port: int) — the pinned direct-connect address
    configured in Settings, or (None, _) if none is set."""
    global _manual_peer_provider
    _manual_peer_provider = fn


def set_online_signaling_provider(fn):
    """fn() -> (enabled: bool, url: str | None) — the signaling Worker's
    wss:// URL configured in Settings, or (False, None) if not set up."""
    global _online_signaling_provider
    _online_signaling_provider = fn


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
    threading.Thread(target=_online_signaling_loop, args=(backend_port, gpu), daemon=True).start()
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


def _online_signaling_loop(backend_port: int, gpu: dict):
    """Keeps one persistent WebSocket open to the signaling Worker (if
    configured), re-sending "hello" on a short interval — both a keepalive
    and what makes the Worker rebroadcast the full peer list on a schedule,
    since without SOME periodic refresh, an online peer with nothing new to
    report would never touch every other client's `last_seen` for it and
    would incorrectly age out via STALE_AFTER_SECONDS despite still being
    connected. Runs forever in its own thread; reconnects on any drop."""
    own_id: str | None = None
    while True:
        enabled, url = _online_signaling_provider() if _online_signaling_provider else (False, None)
        if not enabled or not url:
            _prune_online_peers()
            time.sleep(ONLINE_SIGNALING_RECONNECT_SECONDS)
            continue

        try:
            with ws_connect(url, open_timeout=10) as ws:
                power_logger.info("Online signaling connected url=%s", url)

                def send_hello():
                    name, power_share_enabled, logged_in = (
                        _state_provider() if _state_provider else ("?", False, False)
                    )
                    ws.send(json.dumps({
                        "type": "hello",
                        "port": backend_port,
                        "name": name,
                        "power_share_enabled": power_share_enabled,
                        "logged_in": logged_in,
                        "gpu_name": gpu["name"],
                        "vram_gb": gpu["vram_gb"],
                    }))

                send_hello()
                last_heartbeat = time.monotonic()
                while True:
                    if time.monotonic() - last_heartbeat >= ONLINE_SIGNALING_HEARTBEAT_SECONDS:
                        send_hello()
                        last_heartbeat = time.monotonic()
                    try:
                        raw = ws.recv(timeout=ONLINE_SIGNALING_HEARTBEAT_SECONDS)
                    except TimeoutError:
                        continue
                    msg = json.loads(raw)

                    if msg.get("type") == "welcome":
                        own_id = msg.get("your_id")
                        continue

                    if msg.get("type") == "peers":
                        now = time.time()
                        with _registry_lock:
                            for peer in msg.get("peers", []):
                                if peer.get("id") == own_id:
                                    continue
                                _registry[f"online:{peer['id']}"] = {
                                    "host": peer["host"],
                                    "port": peer["port"],
                                    "name": peer.get("name", "?"),
                                    "power_share_enabled": bool(peer.get("power_share_enabled")),
                                    "logged_in": bool(peer.get("logged_in")),
                                    "gpu_name": peer.get("gpu_name", "Невідома відеокарта"),
                                    "vram_gb": peer.get("vram_gb", 0.0),
                                    "last_seen": now,
                                }
                            # An "online:" entry not in THIS broadcast means
                            # that peer disconnected — drop it immediately
                            # rather than waiting out STALE_AFTER_SECONDS.
                            current_ids = {f"online:{p['id']}" for p in msg.get("peers", []) if p.get("id") != own_id}
                            for key in [k for k in _registry if k.startswith("online:") and k not in current_ids]:
                                del _registry[key]
                        continue
        except (WebSocketException, OSError, TimeoutError) as exc:
            power_logger.info("Online signaling disconnected url=%s error=%s", url, exc)
            _prune_online_peers()
        except Exception:
            power_logger.exception("Online signaling loop crashed unexpectedly")
            _prune_online_peers()

        time.sleep(ONLINE_SIGNALING_RECONNECT_SECONDS)


def _prune_online_peers():
    with _registry_lock:
        for key in [k for k in _registry if k.startswith("online:")]:
            del _registry[key]
