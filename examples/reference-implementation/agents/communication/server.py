#!/usr/bin/env python3
"""Entrypoint: OpenEAGO Phase 6 (Communication & Delivery) reference agent.

Usage: python server.py --allow-insecure [--port=9006] [--no-register]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "_lib"))

from server_base import run_agent  # noqa: E402

from tools import TOOL_HANDLERS  # noqa: E402

if __name__ == "__main__":
    run_agent(Path(__file__).resolve().parent, TOOL_HANDLERS)
