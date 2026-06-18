"""Thin async client for the OpenEAGO Agent Registry (examples/agent-registry)."""
from __future__ import annotations

import httpx

from app.config import REGISTRY_URL


async def discover(capability_code: str) -> dict | None:
    """Return the first healthy registered agent advertising this capability code."""
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.post(
            f"{REGISTRY_URL}/discover",
            json={"capability_codes": [capability_code], "exclude_status": ["quarantine", "unhealthy"]},
        )
        resp.raise_for_status()
        agents = resp.json().get("agents") or []
        return agents[0] if agents else None


async def list_agents() -> list[dict]:
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{REGISTRY_URL}/list")
        resp.raise_for_status()
        return resp.json().get("addresses") or []
