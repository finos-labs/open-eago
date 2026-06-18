"""Enveloped MCP JSON-RPC client for calling OpenEAGO phase agents."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from uuid import uuid4

import httpx

from app.config import SPEC_VERSION


class AgentCallError(RuntimeError):
    pass


async def call_tool(
    http_endpoint: str, phase: str, tool_name: str, arguments: dict, *, correlation_id: str | None = None
) -> tuple[dict, dict]:
    """POST an EAGO-enveloped MCP tools/call to an agent. Returns (result, envelope)."""
    message_id = f"msg-{uuid4()}"
    envelope = {
        "message_id": message_id,
        "spec_version": SPEC_VERSION,
        "phase": phase,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        },
        **({"correlation_id": correlation_id} if correlation_id else {}),
    }

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(f"{http_endpoint.rstrip('/')}/mcp", json=envelope)
        resp.raise_for_status()
        response_envelope = resp.json()

    rpc = response_envelope.get("payload") or {}
    if "error" in rpc:
        raise AgentCallError(f"{tool_name} failed: {rpc['error']}")
    content = (rpc.get("result") or {}).get("content") or []
    if not content:
        raise AgentCallError(f"{tool_name} returned no content")
    result = json.loads(content[0]["text"])
    return result, response_envelope
