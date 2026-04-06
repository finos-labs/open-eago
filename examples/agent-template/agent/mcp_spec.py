"""MCP spec loading and tool/resource/prompt builders."""
from __future__ import annotations

import json
import sys
from pathlib import Path


def load_mcp_spec(base_dir: Path) -> dict:
    path = base_dir / "agent.mcp.json"
    if not path.exists():
        print("agent.mcp.json not found", file=sys.stderr)
        sys.exit(1)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def build_tools_from_spec(mcp_spec: dict, config: dict) -> dict:
    tools = {}
    for t in mcp_spec.get("tools") or []:
        name = t.get("name", "")
        if name == "eago_health":

            def handler(args: dict, _t=t, _cfg=config, _spec=mcp_spec):
                meta = _cfg.get("metadata") or {}
                return {
                    "status": "ok",
                    "agent": meta.get("name") or _spec.get("name"),
                    "version": meta.get("version") or _spec.get("version"),
                    "spec_version": meta.get("spec_version") or "0.1.0",
                    "eago_phases": (
                        meta.get("eago_phases")
                        or _spec.get("open_eago", {}).get("eago_phases")
                        or []
                    ),
                    "phase": args.get("phase"),
                    "capabilities": meta.get("capabilities") or [],
                }

        else:

            def handler(args: dict, _n=name):  # noqa: F811
                return {"ok": True, "tool": _n}

        tools[name] = {
            "description": t.get("description") or "",
            "input_schema": t.get("inputSchema") or {"type": "object", "properties": {}},
            "handler": handler,
        }
    return tools


def build_resources_from_spec(mcp_spec: dict) -> dict:
    """Build a resource map keyed by URI from the MCP spec's resources array."""
    resources = {}
    for r in mcp_spec.get("resources") or []:
        uri = r.get("uri", "")
        if not uri:
            continue
        resources[uri] = {
            "name": r.get("name") or uri,
            "description": r.get("description") or "",
            "mime_type": r.get("mimeType") or "text/plain",
            "contents": r.get("contents") or "",
        }
    return resources


def build_prompts_from_spec(mcp_spec: dict) -> dict:
    """Build a prompt map keyed by name from the MCP spec's prompts array."""
    prompts = {}
    for p in mcp_spec.get("prompts") or []:
        name = p.get("name", "")
        if not name:
            continue
        prompts[name] = {
            "description": p.get("description") or "",
            "arguments": p.get("arguments") or [],
            "messages": p.get("messages") or [],
        }
    return prompts
