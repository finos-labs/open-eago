#!/usr/bin/env python3
"""
OpenEAGO RPC Demo Agent — entrypoint.

Usage:
  python demo_agent.py [--config=config.yaml] [--port=9000] [--no-register]
  python demo_agent.py --allow-insecure   # HTTP only, no mTLS (dev only)

Requires: config.yaml (or config.example.yaml), agent.mcp.json, and when not
  --allow-insecure: SPIRE cert_path, key_path, bundle_path.

Implementation is split across the agent/ package:
  agent/config.py       — config loading and validation
  agent/runtime.py      — AgentRuntime metrics
  agent/mcp_spec.py     — MCP spec loading and tool/resource/prompt builders
  agent/card.py         — agent discovery card
  agent/mcp_handler.py  — MCP dispatcher and HTTP(S) handler
  agent/registry.py     — registry client (registration, status, deregistration)
"""
from __future__ import annotations

import argparse
import signal
import sys
import threading
from http.server import HTTPServer
from pathlib import Path

from agent.card import build_agent_card
from agent.config import load_config
from agent.mcp_handler import MCPHandler, make_ssl_context_server
from agent.mcp_spec import (
    build_prompts_from_spec,
    build_resources_from_spec,
    build_tools_from_spec,
    load_mcp_spec,
)
from agent.registry import (
    deregister_from_registry,
    register_with_registry,
    status_loop,
    sync_loop,
)
from agent.runtime import AgentRuntime

BASE_DIR = Path(__file__).resolve().parent


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenEAGO RPC Demo Agent (Python, SPIRE mTLS)")
    parser.add_argument("--config", type=Path, default=None, help="Path to config.yaml")
    parser.add_argument("--port", type=int, default=None, help="Override server port")
    parser.add_argument("--no-register", action="store_true", help="Do not register with registry")
    parser.add_argument(
        "--allow-insecure",
        action="store_true",
        help="Use HTTP only and skip mTLS (dev only; not for production)",
    )
    args = parser.parse_args()

    config = load_config(args, BASE_DIR)
    mcp_spec = load_mcp_spec(BASE_DIR)

    server_cfg = config.get("server") or {}
    host = server_cfg.get("host", "127.0.0.1")
    port = server_cfg.get("port", 9000)
    address = f"{host}:{port}"

    MCPHandler.tools = build_tools_from_spec(mcp_spec, config)
    MCPHandler.resources = build_resources_from_spec(mcp_spec)
    MCPHandler.prompts = build_prompts_from_spec(mcp_spec)
    MCPHandler.config = config
    MCPHandler.port = port

    use_mtls = (config.get("spire") or {}).get("enabled") and not config.get("_allow_insecure")

    if use_mtls:
        spire = config.get("spire") or {}
        for key in ("cert_path", "key_path", "bundle_path"):
            p = spire.get(key)
            if not p or not Path(p).exists():
                print(
                    f"SPIRE {key} not found at {p}. "
                    "Run SPIRE and fetch SVID, or use --allow-insecure for dev.",
                    file=sys.stderr,
                )
                sys.exit(1)
        ssl_ctx = make_ssl_context_server(spire)
    else:
        ssl_ctx = None

    agent_card = build_agent_card(config, mcp_spec, host, port, use_mtls=use_mtls)
    MCPHandler.agent_card = agent_card

    runtime = AgentRuntime(agent_card.get("name") or "agent")
    runtime.start()
    MCPHandler.runtime = runtime

    server = HTTPServer((host, port), MCPHandler)
    if ssl_ctx:
        server.socket = ssl_ctx.wrap_socket(server.socket, server_side=True)

    scheme = "https" if ssl_ctx else "http"
    print(f"[demo-agent] OpenEAGO RPC agent → {scheme}://{address} (SPIRE mTLS: {use_mtls})")
    print("[demo-agent] GET / or GET /.well-known/agent → agent card")
    print("[demo-agent] POST /mcp → MCP JSON-RPC (tools/list, tools/call)")
    print("[demo-agent] POST /api/execute → OpenEMCP-style execute endpoint")
    print("[demo-agent] GET /health, GET /metrics → OpenEMCP-style health/metrics")

    bootstrap_cfg = config.get("bootstrap") or {}
    stop = threading.Event()

    if config.get("_do_register") and bootstrap_cfg.get("urls"):
        register_with_registry(config, address, runtime=runtime)
        threading.Thread(
            target=sync_loop, args=(config, address, stop, runtime), daemon=True,
        ).start()
        threading.Thread(
            target=status_loop, args=(config, address, stop, runtime), daemon=True,
        ).start()
        print(f"[demo-agent] Registry sync every {bootstrap_cfg.get('sync_interval') or 30}s")
        print(f"[demo-agent] Status push every {bootstrap_cfg.get('status_interval') or 10}s")
    elif config.get("_do_register"):
        print("[demo-agent] No bootstrap.urls configured; skip registration.")

    def _shutdown(sig=None, frame=None):
        print(f"[demo-agent] Shutting down (signal={sig})…")
        stop.set()
        if config.get("_do_register") and bootstrap_cfg.get("urls"):
            deregister_from_registry(config, address)
        runtime.stop()
        server.shutdown()

    signal.signal(signal.SIGTERM, _shutdown)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        _shutdown()


if __name__ == "__main__":
    main()
