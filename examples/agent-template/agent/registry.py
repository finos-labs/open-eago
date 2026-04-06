"""Registry client: registration, status push, deregistration, and sync loops."""
from __future__ import annotations

import json
import ssl
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

if TYPE_CHECKING:
    from agent.runtime import AgentRuntime


def _ssl_context_for_registry(spire: dict) -> ssl.SSLContext:
    """SSL context for registry client: client cert + CA bundle, no hostname check (SPIFFE SAN)."""
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
    ctx.load_cert_chain(spire["cert_path"], spire["key_path"])
    ctx.load_verify_locations(cafile=spire["bundle_path"])
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.check_hostname = False  # Registry uses SPIFFE SAN (spiffe://...), not DNS
    return ctx


def _registry_request(
    config: dict, url: str, method: str, body: dict | None = None
) -> dict | None:
    """Send a single HTTP(S) request to the registry. Returns parsed JSON or None on failure."""
    spire = config.get("spire") or {}
    use_mtls = spire.get("enabled") and not config.get("_allow_insecure")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = Request(url, data=data, method=method, headers=headers)
    try:
        ctx = (
            _ssl_context_for_registry(spire)
            if use_mtls and Path(spire.get("cert_path", "")).exists()
            else None
        )
        with urlopen(req, timeout=10, **({"context": ctx} if ctx else {})) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        print(f"[demo-agent] {method} {url} failed: {e.code} {e.read().decode()}", file=sys.stderr)
    except URLError as e:
        print(f"[demo-agent] {method} {url} error: {e.reason}", file=sys.stderr)
    except Exception as e:
        print(f"[demo-agent] {method} {url} error: {e}", file=sys.stderr)
    return None


def build_agent_details(
    config: dict, address: str, runtime: "AgentRuntime | None" = None
) -> dict:
    a = config.get("agent") or {}
    meta = config.get("metadata") or {}
    endpoints = a.get("endpoints") or {}
    scheme = "https" if config.get("spire", {}).get("enabled") else "http"

    # Prefer live runtime values over static config when available.
    if runtime is not None:
        reliability = runtime.reliability()
        health_status = "healthy" if runtime.running else "unhealthy"
        uptime_percentage = runtime.uptime_percentage()
    else:
        reliability = a.get("reliability", 0.99)
        health_status = a.get("health_status", "healthy")
        uptime_percentage = a.get("uptime_percentage")

    return {
        "instance_id": a.get("instance_id"),
        "capability_codes": a.get("capability_codes") or meta.get("capabilities") or [],
        "version": a.get("version") or meta.get("version") or "0.1.0",
        "jurisdiction": a.get("jurisdiction"),
        "data_center": a.get("data_center"),
        "compliance": a.get("compliance") if isinstance(a.get("compliance"), list) else [],
        "reliability": reliability,
        "health_status": health_status,
        "uptime_percentage": uptime_percentage,
        "endpoints": {
            "http": endpoints.get("http") or f"http://{address}",
            "https": endpoints.get("https") or f"{scheme}://{address}",
            "grpc": endpoints.get("grpc"),
            "websocket": endpoints.get("websocket"),
            "custom": endpoints.get("custom") or {},
        },
        "resource_limits": a.get("resource_limits") or {},
        "tags": a.get("tags") if isinstance(a.get("tags"), dict) else {},
    }


def register_with_registry(
    config: dict, address: str, runtime: "AgentRuntime | None" = None
) -> None:
    urls = (config.get("bootstrap") or {}).get("urls") or []
    if not urls:
        return
    body = {
        "address": address,
        "known_bootstrap_urls": urls,
        "agent_details": build_agent_details(config, address, runtime=runtime),
    }
    for base in urls:
        url = f"{base.rstrip('/')}/register"
        resp = _registry_request(config, url, "POST", body)
        if resp is None:
            continue
        print(f"[demo-agent] Registered with {url}")
        # Quarantine detection: warn if registry considers this agent quarantined.
        for entry in resp.get("known_addresses") or []:
            if entry.get("address") == address and entry.get("health_status") == "quarantine":
                print(
                    f"[demo-agent] WARNING: registry has quarantined {address}. "
                    "Check TTL and network connectivity.",
                    file=sys.stderr,
                )


def push_status_to_registry(
    config: dict, address: str, runtime: "AgentRuntime | None"
) -> None:
    """Push live reliability, health, and uptime to the registry via PUT /status."""
    urls = (config.get("bootstrap") or {}).get("urls") or []
    if not urls or runtime is None:
        return
    body = {
        "address": address,
        "reliability": runtime.reliability(),
        "health_status": "healthy" if runtime.running else "unhealthy",
        "uptime_percentage": runtime.uptime_percentage(),
    }
    for base in urls:
        url = f"{base.rstrip('/')}/status"
        resp = _registry_request(config, url, "PUT", body)
        if resp:
            print(
                f"[demo-agent] Status pushed to {url}: "
                f"reliability={body['reliability']:.3f} "
                f"health={body['health_status']} "
                f"uptime={body['uptime_percentage']:.1f}%"
            )


def deregister_from_registry(config: dict, address: str) -> None:
    """Gracefully remove this agent from all bootstrap registries on shutdown."""
    urls = (config.get("bootstrap") or {}).get("urls") or []
    if not urls:
        return
    encoded = quote(address, safe="")
    for base in urls:
        url = f"{base.rstrip('/')}/register/{encoded}"
        resp = _registry_request(config, url, "DELETE")
        if resp is not None:
            print(f"[demo-agent] Deregistered from {url}")
        else:
            # Registry may not have DELETE yet; log and continue.
            print(
                f"[demo-agent] Deregister from {url} skipped (endpoint not available)",
                file=sys.stderr,
            )


def sync_loop(
    config: dict,
    address: str,
    stop: threading.Event,
    runtime: "AgentRuntime | None" = None,
) -> None:
    interval = (config.get("bootstrap") or {}).get("sync_interval") or 30
    while not stop.wait(interval):
        register_with_registry(config, address, runtime=runtime)


def status_loop(
    config: dict,
    address: str,
    stop: threading.Event,
    runtime: "AgentRuntime | None",
) -> None:
    """Push live status updates to the registry at status_interval cadence."""
    interval = (config.get("bootstrap") or {}).get("status_interval") or 10
    while not stop.wait(interval):
        push_status_to_registry(config, address, runtime)
