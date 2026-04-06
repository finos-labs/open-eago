"""Agent card builder for the OpenEAGO agent discovery document."""
from __future__ import annotations


def build_agent_card(
    config: dict, mcp_spec: dict, host: str, port: int, use_mtls: bool = False
) -> dict:
    address = f"{host}:{port}"
    scheme = "https" if use_mtls else "http"
    meta = config.get("metadata") or {}
    return {
        "name": meta.get("name") or mcp_spec.get("name"),
        "version": meta.get("version") or mcp_spec.get("version"),
        "description": meta.get("description") or "",
        "capabilities": meta.get("capabilities") or [],
        "endpoint": f"{scheme}://{address}",
        "open_eago": mcp_spec.get("open_eago") or {},
        "eago_phases": (
            meta.get("eago_phases")
            or mcp_spec.get("open_eago", {}).get("eago_phases")
            or []
        ),
        "tags": meta.get("tags") or [],
    }
