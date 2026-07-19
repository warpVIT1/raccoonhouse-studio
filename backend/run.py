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

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    # 0.0.0.0 so the optional power-sharing feature can reach this machine over
    # LAN — power-share endpoints stay inert unless explicitly enabled in Settings.
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    os.environ["RH_BACKEND_PORT"] = str(args.port)

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=False,
    )
