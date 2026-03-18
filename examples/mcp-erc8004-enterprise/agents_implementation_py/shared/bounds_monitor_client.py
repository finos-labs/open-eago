"""
bounds_monitor_client.py — Client-side interface to the autonomy bounds monitor.

Reads bounds-state.json written by bounds-monitor.js (Node.js process, stays alive).
Optionally POSTs metrics to the bounds monitor HTTP API on :9090/report.

The bounds-state.json lives in agents_implementation/ (shared with Node.js).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# Path to the shared bounds-state.json written by bounds-monitor.js.
# Override via BOUNDS_STATE_PATH env var for Python-only runs
# (e.g. BOUNDS_STATE_PATH=/dev/null or point to a standalone file).
_BOUNDS_STATE_PATH = Path(
    os.environ.get(
        "BOUNDS_STATE_PATH",
        str(
            Path(__file__).parent.parent.parent  # mcp-8004-enterprise/
            / "agents_implementation"
            / "bounds-state.json"
        ),
    )
)

# Default bounds monitor HTTP endpoint
_BOUNDS_MONITOR_URL = os.getenv("BOUNDS_MONITOR_URL", "http://localhost:9090")


def read_bounds_state() -> dict:
    """Read the current bounds-state.json. Returns {} if not found or invalid."""
    try:
        return json.loads(_BOUNDS_STATE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def is_tool_suspended(tool_name: str) -> tuple[bool, str]:
    """
    Check if a tool is currently suspended by the autonomy bounds monitor.

    Returns:
        (suspended: bool, reason: str)
    """
    state = read_bounds_state()
    entry = state.get(tool_name)
    if not entry or entry.get("enabled") is not False:
        return False, ""
    reason = entry.get("disabledReason", "revoked by autonomy bounds")
    return True, reason


def report_tool_call(
    tool_name: str,
    *,
    success: bool,
    latency_ms: Optional[float] = None,
    error: Optional[str] = None,
) -> None:
    """
    Report a tool call outcome to the bounds monitor.
    Fire-and-forget; errors are logged, not raised.

    Compatible with the bounds-monitor.js POST /report endpoint:
        { "tool": "<name>", "success": bool, "latencyMs": number, "error": string }
    """
    payload: dict = {"tool": tool_name, "success": success}
    if latency_ms is not None:
        payload["latencyMs"] = latency_ms
    if error is not None:
        payload["error"] = error

    try:
        httpx.post(
            f"{_BOUNDS_MONITOR_URL}/report",
            json=payload,
            timeout=2,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("bounds-monitor report failed (non-fatal): %s", exc)
