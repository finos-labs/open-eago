"""
bounds_monitor.py — Off-chain autonomy bounds monitor (Layers 6 and 7).
Python port of bounds-monitor.js.

Reads autonomy_bounds from all MCP specs, tracks sliding-window metrics per
tool, and enforces two policies that cannot be checked on-chain:

  Layer 6 – error/success rate violations  (anomaly + performance signals)
  Layer 7 – burst rate + response timeout   (flow signal)

On violation:
  1. Writes bounds-state.json — MCP servers read this on every request to
     surface x_suspended / x_suspension_reason in tools/list responses.
  2. (Optional) Calls disableTool() on AutonomyBoundsRegistry on-chain so
     oracle bridges are also blocked before submitting fulfilment transactions.

On recovery (metrics return within bounds):
  Both state file and on-chain entry are re-enabled automatically.

HTTP control API (default port 9090):
  POST /report   { toolName, success, latencyMs, agentId? }
  GET  /state    → current bounds-state (same object written to bounds-state.json)
  GET  /metrics  → per-tool sliding-window statistics and burst counts
  POST /reset    { toolName }  → force-enable a tool (testing / operator override)

CLI flags (all optional when --mock is set):
  --rpc <url>              JSON-RPC endpoint  (default: http://127.0.0.1:8545)
  --privkey <hex>          Signer private key for on-chain calls
  --autonomy-bounds <addr> AutonomyBoundsRegistry contract address
  --agent-id <n>           Default agentId for all tools  (default: 0)
  --agent-ids <json>       JSON map of toolName → agentId, overrides --agent-id
  --port <n>               HTTP port for the control API  (default: 9090)
  --state-path <path>      Output path for bounds-state.json
  --specs-dir <path>       Directory containing *.mcp.json files
  --mock                   Skip on-chain calls entirely
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from web3 import AsyncWeb3, Web3
from web3.middleware import SignAndSendRawMiddlewareBuilder

from shared.abis import AUTONOMY_BOUNDS_ABI

logging.basicConfig(level=logging.INFO, format="[bounds-monitor] %(message)s")
logger = logging.getLogger("bounds-monitor")

# ── Sliding window ─────────────────────────────────────────────────────────────

class SlidingWindow:
    """Fixed-size circular buffer of boolean outcomes (True = success)."""

    def __init__(self, max_size: int) -> None:
        self._buf: deque[bool] = deque(maxlen=max_size)
        self.max_size = max_size

    def push(self, success: bool) -> None:
        self._buf.append(success)

    @property
    def size(self) -> int:
        return len(self._buf)

    @property
    def success_count(self) -> int:
        return sum(self._buf)

    @property
    def error_count(self) -> int:
        return self.size - self.success_count

    @property
    def error_rate_pct(self) -> float:
        return 0.0 if self.size == 0 else (self.error_count / self.size) * 100

    @property
    def success_rate_pct(self) -> float:
        return 100.0 if self.size == 0 else (self.success_count / self.size) * 100

    def stats(self) -> dict:
        return {
            "size": self.size,
            "successCount": self.success_count,
            "errorCount": self.error_count,
            "errorRatePct": round(self.error_rate_pct, 1),
            "successRatePct": round(self.success_rate_pct, 1),
        }


# ── Burst tracker ──────────────────────────────────────────────────────────────

class BurstTracker:
    """Rolling 60-second timestamp buffer."""

    def __init__(self, max_per_minute: int) -> None:
        self.max_per_minute = max_per_minute
        self._timestamps: deque[float] = deque()

    def _prune(self) -> None:
        cutoff = time.time() - 60.0
        while self._timestamps and self._timestamps[0] < cutoff:
            self._timestamps.popleft()

    def record(self) -> None:
        self._prune()
        self._timestamps.append(time.time())

    @property
    def count_per_minute(self) -> int:
        self._prune()
        return len(self._timestamps)

    def is_exceeded(self) -> bool:
        return self.count_per_minute > self.max_per_minute


# ── Per-tool runtime state ─────────────────────────────────────────────────────

@dataclass
class ToolState:
    spec_file: str
    bounds: dict
    agent_id: int
    tool_hash: bytes                      # keccak256(toolName) as bytes32

    anomaly_window: SlidingWindow
    performance_window: SlidingWindow
    burst_tracker: Optional[BurstTracker]
    response_timeout_ms: Optional[float]

    enabled: bool = True
    disabled_reason: Optional[str] = None
    disabled_at: Optional[float] = None   # unix timestamp


# ── Spec loading ───────────────────────────────────────────────────────────────

def load_specs(specs_dir: Path) -> dict[str, dict]:
    """
    Walk all *.mcp.json files and collect per-tool autonomy_bounds configs.
    Returns { toolName: { specFile, bounds } }
    """
    tool_bounds: dict[str, dict] = {}
    for f in sorted(specs_dir.glob("*.mcp.json")):
        spec = json.loads(f.read_text(encoding="utf-8"))
        for tool in spec.get("tools", []):
            ab = tool.get("autonomy_bounds", {})
            if ab:
                tool_bounds[tool["name"]] = {"spec_file": f.name, "bounds": ab}
    return tool_bounds


def init_tool_states(
    tool_bounds: dict[str, dict],
    default_agent_id: int,
    agent_id_overrides: dict[str, int],
) -> dict[str, ToolState]:
    states: dict[str, ToolState] = {}
    for tool_name, info in tool_bounds.items():
        bounds = info["bounds"]
        agent_id = agent_id_overrides.get(tool_name, agent_id_overrides.get("*", default_agent_id))
        tool_hash = bytes(Web3.keccak(text=tool_name))

        states[tool_name] = ToolState(
            spec_file=info["spec_file"],
            bounds=bounds,
            agent_id=agent_id,
            tool_hash=tool_hash,
            anomaly_window=SlidingWindow(bounds.get("anomaly", {}).get("window_requests", 50)),
            performance_window=SlidingWindow(bounds.get("performance", {}).get("window_requests", 100)),
            burst_tracker=(
                BurstTracker(bounds["flow"]["max_requests_per_minute"])
                if bounds.get("flow", {}).get("max_requests_per_minute")
                else None
            ),
            response_timeout_ms=(
                bounds["flow"]["response_timeout_seconds"] * 1000
                if bounds.get("flow", {}).get("response_timeout_seconds")
                else None
            ),
        )
    return states


# ── Threshold evaluation ───────────────────────────────────────────────────────

def evaluate_thresholds(state: ToolState, latency_ms: Optional[float]) -> tuple[bool, Optional[str]]:
    """Returns (violated, reason)."""
    bounds = state.bounds

    if "anomaly" in bounds:
        cfg = bounds["anomaly"]
        w = state.anomaly_window
        if w.size >= cfg["window_requests"] and w.error_rate_pct > cfg["max_error_rate_pct"]:
            return True, (
                f"error rate {w.error_rate_pct:.1f}% exceeded threshold "
                f"{cfg['max_error_rate_pct']}% over last {w.size} requests"
            )

    if "performance" in bounds:
        cfg = bounds["performance"]
        w = state.performance_window
        if w.size >= cfg["window_requests"] and w.success_rate_pct < cfg["min_success_rate_pct"]:
            return True, (
                f"success rate {w.success_rate_pct:.1f}% below threshold "
                f"{cfg['min_success_rate_pct']}% over last {w.size} requests"
            )

    if "flow" in bounds:
        if state.burst_tracker and state.burst_tracker.is_exceeded():
            return True, (
                f"burst rate {state.burst_tracker.count_per_minute} req/min "
                f"exceeded limit {bounds['flow']['max_requests_per_minute']}"
            )
        if latency_ms is not None and state.response_timeout_ms is not None:
            if latency_ms > state.response_timeout_ms:
                return True, (
                    f"response timeout: {latency_ms:.0f}ms exceeded "
                    f"limit {state.response_timeout_ms:.0f}ms"
                )

    return False, None


def has_recovered(state: ToolState) -> bool:
    bounds = state.bounds

    if "anomaly" in bounds:
        cfg = bounds["anomaly"]
        w = state.anomaly_window
        if w.size >= cfg["window_requests"] and w.error_rate_pct > cfg["max_error_rate_pct"]:
            return False

    if "performance" in bounds:
        cfg = bounds["performance"]
        w = state.performance_window
        if w.size >= cfg["window_requests"] and w.success_rate_pct < cfg["min_success_rate_pct"]:
            return False

    if state.burst_tracker and state.burst_tracker.is_exceeded():
        return False

    return True


# ── State persistence ──────────────────────────────────────────────────────────

def persist_state(tool_states: dict[str, ToolState], state_path: Path) -> None:
    out = {
        name: {
            "enabled": s.enabled,
            "disabledReason": s.disabled_reason,
            "disabledAt": s.disabled_at,
        }
        for name, s in tool_states.items()
    }
    state_path.write_text(json.dumps(out, indent=2), encoding="utf-8")


# ── On-chain write (optional) ──────────────────────────────────────────────────

async def on_chain_disable(contract: Any, agent_id: int, tool_hash: bytes, reason: str, label: str) -> None:
    if contract is None:
        return
    try:
        tx_hash = await contract.functions.disableTool(agent_id, tool_hash, reason).transact()
        logger.info("%s disableTool tx=%s", label, tx_hash.hex())
    except Exception as exc:
        logger.warning("%s disableTool failed: %s", label, exc)


async def on_chain_enable(contract: Any, agent_id: int, tool_hash: bytes, label: str) -> None:
    if contract is None:
        return
    try:
        tx_hash = await contract.functions.enableTool(agent_id, tool_hash).transact()
        logger.info("%s enableTool tx=%s", label, tx_hash.hex())
    except Exception as exc:
        logger.warning("%s enableTool failed: %s", label, exc)


# ── Core: process a tool call report ──────────────────────────────────────────

async def process_report(
    payload: dict,
    tool_states: dict[str, ToolState],
    state_path: Path,
    contract: Any,
    lock: asyncio.Lock,
) -> dict:
    tool_name = payload.get("toolName")
    success = bool(payload.get("success"))
    latency_ms: Optional[float] = payload.get("latencyMs")
    report_agent_id: Optional[int] = payload.get("agentId")

    async with lock:
        state = tool_states.get(tool_name)
        if state is None:
            logger.warning("unknown tool in report: %s", tool_name)
            return {"ok": False, "message": f"unknown tool: {tool_name}"}

        state.anomaly_window.push(success)
        state.performance_window.push(success)
        if state.burst_tracker:
            state.burst_tracker.record()

        agent_id = report_agent_id if report_agent_id is not None else state.agent_id

        if state.enabled:
            violated, reason = evaluate_thresholds(state, latency_ms)
            if violated:
                logger.warning("THRESHOLD VIOLATED [%s] — suspending: %s", tool_name, reason)
                state.enabled = False
                state.disabled_reason = reason
                state.disabled_at = time.time()
                persist_state(tool_states, state_path)
                await on_chain_disable(contract, agent_id, state.tool_hash, reason, tool_name)
                return {"ok": True, "action": "suspended", "reason": reason}
        else:
            if has_recovered(state):
                logger.info("RECOVERED [%s] — re-enabling", tool_name)
                state.enabled = True
                state.disabled_reason = None
                state.disabled_at = None
                persist_state(tool_states, state_path)
                await on_chain_enable(contract, agent_id, state.tool_hash, tool_name)
                return {"ok": True, "action": "recovered"}

    return {"ok": True, "action": "recorded", "suspended": not state.enabled}


# ── HTTP routes ────────────────────────────────────────────────────────────────

def make_app(
    tool_states: dict[str, ToolState],
    state_path: Path,
    contract: Any,
    lock: asyncio.Lock,
) -> Starlette:

    async def get_state(request: Request) -> JSONResponse:
        out = {
            name: {
                "enabled": s.enabled,
                "disabledReason": s.disabled_reason,
                "disabledAt": s.disabled_at,
            }
            for name, s in tool_states.items()
        }
        return JSONResponse(out)

    async def get_metrics(request: Request) -> JSONResponse:
        out = {}
        for name, s in tool_states.items():
            out[name] = {
                "enabled": s.enabled,
                "agentId": s.agent_id,
                "specFile": s.spec_file,
                "anomaly": (
                    {**s.anomaly_window.stats(), "threshold": f"{s.bounds['anomaly']['max_error_rate_pct']}%"}
                    if "anomaly" in s.bounds else None
                ),
                "performance": (
                    {**s.performance_window.stats(), "threshold": f"{s.bounds['performance']['min_success_rate_pct']}%"}
                    if "performance" in s.bounds else None
                ),
                "burst": (
                    {"countPerMinute": s.burst_tracker.count_per_minute, "limit": s.bounds["flow"]["max_requests_per_minute"]}
                    if s.burst_tracker else None
                ),
                "responseTimeoutMs": s.response_timeout_ms,
            }
        return JSONResponse(out)

    async def post_report(request: Request) -> JSONResponse:
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if not payload.get("toolName") or payload.get("success") is None:
            return JSONResponse({"error": "toolName and success are required"}, status_code=400)
        result = await process_report(payload, tool_states, state_path, contract, lock)
        return JSONResponse(result)

    async def post_reset(request: Request) -> JSONResponse:
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        tool_name = payload.get("toolName")
        async with lock:
            state = tool_states.get(tool_name)
            if state is None:
                return JSONResponse({"error": f"unknown tool: {tool_name}"}, status_code=404)
            state.enabled = True
            state.disabled_reason = None
            state.disabled_at = None
            persist_state(tool_states, state_path)
            await on_chain_enable(contract, state.agent_id, state.tool_hash, tool_name)
        logger.info("FORCE-RESET [%s] by operator", tool_name)
        return JSONResponse({"ok": True, "action": "reset", "toolName": tool_name})

    return Starlette(routes=[
        Route("/state",   get_state,   methods=["GET"]),
        Route("/metrics", get_metrics, methods=["GET"]),
        Route("/report",  post_report, methods=["POST"]),
        Route("/reset",   post_reset,  methods=["POST"]),
    ])


# ── Main ───────────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Autonomy bounds monitor — Layers 6 and 7")
    p.add_argument("--rpc",             default=None)
    p.add_argument("--privkey",         default=None)
    p.add_argument("--autonomy-bounds", dest="autonomy_bounds", default=None)
    p.add_argument("--agent-id",        dest="agent_id",        default="0")
    p.add_argument("--agent-ids",       dest="agent_ids",       default=None,
                   help='JSON map of toolName → agentId, e.g. \'{"screen_client": 0}\'')
    p.add_argument("--port",            type=int, default=9090)
    p.add_argument("--state-path",      dest="state_path",      default=None)
    p.add_argument("--specs-dir",       dest="specs_dir",       default=None)
    p.add_argument("--mock",            action="store_true")
    return p.parse_args()


async def main() -> None:
    import uvicorn

    args = parse_args()

    rpc_url    = args.rpc or "http://127.0.0.1:8545"
    specs_dir  = Path(args.specs_dir) if args.specs_dir else Path(__file__).parent.parent / "agents" / "mcp"
    state_path = Path(args.state_path) if args.state_path else Path(__file__).parent / "bounds-state.json"
    agent_id_overrides: dict[str, int] = json.loads(args.agent_ids) if args.agent_ids else {}
    default_agent_id = int(args.agent_id)

    logger.info("starting")
    logger.info("specs-dir  : %s", specs_dir)
    logger.info("state-path : %s", state_path)
    logger.info("on-chain   : %s", "disabled (--mock)" if args.mock else (args.autonomy_bounds or "disabled (no address)"))

    tool_bounds = load_specs(specs_dir)
    logger.info("tools with autonomy_bounds: %s", ", ".join(tool_bounds) or "(none)")

    tool_states = init_tool_states(tool_bounds, default_agent_id, agent_id_overrides)
    persist_state(tool_states, state_path)
    logger.info("bounds-state.json written (%d tools)", len(tool_states))

    contract = None
    if not args.mock and args.autonomy_bounds and args.privkey:
        w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(rpc_url))
        account = w3.eth.account.from_key(args.privkey)
        w3.middleware_onion.add(
            await SignAndSendRawMiddlewareBuilder.build(account)
        )
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(args.autonomy_bounds),
            abi=AUTONOMY_BOUNDS_ABI,
        )
        logger.info("AutonomyBoundsRegistry @ %s", args.autonomy_bounds)
    elif not args.mock and args.autonomy_bounds:
        logger.warning("--autonomy-bounds set but --privkey missing — on-chain calls disabled")

    lock = asyncio.Lock()
    app  = make_app(tool_states, state_path, contract, lock)

    config = uvicorn.Config(app, host="0.0.0.0", port=args.port, log_level="warning")
    server = uvicorn.Server(config)
    logger.info("HTTP API → http://localhost:%d", args.port)
    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
