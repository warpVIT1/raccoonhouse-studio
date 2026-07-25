"""
Standalone entry point for the backend server.
Usage: python backend/run.py --port 8765
This file lives inside the backend/ package so relative imports work.
"""
import sys
import os
import argparse

# Ensure parent directory is in path for package imports
_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _root not in sys.path:
    sys.path.insert(0, _root)

# Must run before importing uvicorn (or anything else from requirements.txt)
# — see bootstrap_deps.py for why: a fresh checkout with no venv set up would
# otherwise die on the very next import line with no visible explanation.
from backend.bootstrap_deps import ensure_dependencies
ensure_dependencies()

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    # Loopback only — Power Share no longer accepts direct inbound connections
    # from other PCs (everything routes through the Cloudflare signaling
    # Worker instead, see backend/services/discovery_service.py), so nothing
    # needs this machine's local API reachable from the LAN anymore.
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    os.environ["RH_BACKEND_PORT"] = str(args.port)

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=False,
    )
