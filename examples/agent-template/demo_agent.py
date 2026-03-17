#!/usr/bin/env python3
"""
OpenEAGO RPC Demo Agent (Python)

Config-driven MCP JSON-RPC agent with SPIRE mTLS: server and registry client
use SPIRE-issued certificates (SVID + bundle). Compliant with the agent-template
and OpenEAGO Agent Registry.

Usage:
  python demo_agent.py [--config=config.yaml] [--port=9000] [--no-register]
  python demo_agent.py --allow-insecure   # HTTP only, no mTLS (dev only)

Requires: config.yaml (or config.example.yaml), agent.mcp.json, and when not
  --allow-insecure: SPIRE cert_path, key_path, bundle_path.
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import threading
import time
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

try:
    import yaml
except ImportError:
    print("pip install PyYAML", file=sys.stderr)
    sys.exit(1)


# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent

DEFAULTS = {
    "server": {"host": "127.0.0.1", "port": 9000, "transport": "streamable-http"},
    "metadata": {
        "name": "open-eago-mcp-agent",
        "version": "0.1.0",
        "eago_phases": [],
        "capabilities": [],
        "tags": [],
    },
    "agent": {
        "capability_codes": [],
        "version": "0.1.0",
        "health_status": "healthy",
        "reliability": 0.99,
        "endpoints": {},
        "compliance": [],
        "tags": {},
    },
    "mcp": {"protocol_version": "2024-11-05", "eago_envelope": False},
    "spire": {
        "enabled": True,
        "cert_path": os.environ.get("SPIRE_CERT_PATH", "/tmp/svid.0.pem"),
        "key_path": os.environ.get("SPIRE_KEY_PATH", "/tmp/svid.0.key"),
        "bundle_path": os.environ.get("SPIRE_BUNDLE_PATH", "/tmp/bundle.0.pem"),
    },
    "bootstrap": {"urls": [], "sync_interval": 30},
}


def deep_merge(target: dict, source: dict | None) -> dict:
    if source is None:
        return target
    out = dict(target)
    for k, v in source.items():
        if isinstance(v, dict) and not isinstance(v.get("_"), type):
            out[k] = deep_merge(out.get(k) or {}, v)
        else:
            out[k] = v
    return out


def load_config(args: argparse.Namespace) -> dict:
    config_path = args.config or (SCRIPT_DIR / "config.yaml")
    if not config_path.exists():
        config_path = SCRIPT_DIR / "config.example.yaml"
    if not config_path.exists():
        print("No config.yaml or config.example.yaml found", file=sys.stderr)
        sys.exit(1)
    with open(config_path, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    config = deep_merge(DEFAULTS, data)
    if args.port is not None:
        config["server"]["port"] = args.port
    config["_do_register"] = not args.no_register
    config["_allow_insecure"] = getattr(args, "allow_insecure", False)
    return config


# -----------------------------------------------------------------------------
# MCP spec and tools
# -----------------------------------------------------------------------------


def load_mcp_spec() -> dict:
    path = SCRIPT_DIR / "agent.mcp.json"
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
                    "eago_phases": meta.get("eago_phases") or _spec.get("open_eago", {}).get("eago_phases") or [],
                    "phase": args.get("phase"),
                    "capabilities": meta.get("capabilities") or [],
                }

        else:

            def handler(args: dict, _n=name):
                return {"ok": True, "tool": _n}

        tools[name] = {
            "description": t.get("description") or "",
            "input_schema": t.get("inputSchema") or {"type": "object", "properties": {}},
            "handler": handler,
        }
    return tools


# -----------------------------------------------------------------------------
# Registry registration (mTLS when SPIRE enabled)
# -----------------------------------------------------------------------------


def _ssl_context_for_registry(spire: dict):
    """SSL context for registry client: client cert + CA bundle, no hostname check (SPIFFE SAN)."""
    ctx = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
    ctx.load_cert_chain(spire["cert_path"], spire["key_path"])
    ctx.load_verify_locations(cafile=spire["bundle_path"])
    ctx.verify_mode = ssl.CERT_REQUIRED
    ctx.check_hostname = False  # Registry uses SPIFFE SAN (spiffe://...), not DNS
    return ctx


def build_agent_details(config: dict, address: str) -> dict:
    a = config.get("agent") or {}
    meta = config.get("metadata") or {}
    endpoints = a.get("endpoints") or {}
    scheme = "https" if config.get("spire", {}).get("enabled") else "http"
    return {
        "instance_id": a.get("instance_id"),
        "capability_codes": a.get("capability_codes") or meta.get("capabilities") or [],
        "version": a.get("version") or meta.get("version") or "0.1.0",
        "jurisdiction": a.get("jurisdiction"),
        "data_center": a.get("data_center"),
        "compliance": a.get("compliance") if isinstance(a.get("compliance"), list) else [],
        "reliability": a.get("reliability", 0.99),
        "health_status": a.get("health_status", "healthy"),
        "uptime_percentage": a.get("uptime_percentage"),
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


def register_with_registry(config: dict, address: str) -> None:
    urls = (config.get("bootstrap") or {}).get("urls") or []
    if not urls:
        return
    body = {
        "address": address,
        "known_bootstrap_urls": urls,
        "agent_details": build_agent_details(config, address),
    }
    data = json.dumps(body).encode("utf-8")
    spire = config.get("spire") or {}
    use_mtls = spire.get("enabled") and not config.get("_allow_insecure")

    for base in urls:
        base = base.rstrip("/")
        url = f"{base}/register"
        try:
            req = Request(url, data=data, method="POST", headers={"Content-Type": "application/json"})
            if use_mtls and Path(spire.get("cert_path", "")).exists():
                ctx = _ssl_context_for_registry(spire)
                with urlopen(req, timeout=10, context=ctx) as resp:
                    _ = resp.read()
                print(f"[demo-agent] Registered with {url}")
            else:
                with urlopen(req, timeout=10) as resp:
                    _ = resp.read()
                print(f"[demo-agent] Registered with {url}")
        except HTTPError as e:
            print(f"[demo-agent] Register {url} failed: {e.code} {e.read().decode()}", file=sys.stderr)
        except URLError as e:
            print(f"[demo-agent] Register {url} error: {e.reason}", file=sys.stderr)
        except Exception as e:
            print(f"[demo-agent] Register {url} error: {e}", file=sys.stderr)


def sync_loop(config: dict, address: str, stop: threading.Event) -> None:
    interval = (config.get("bootstrap") or {}).get("sync_interval") or 30
    while not stop.wait(interval):
        register_with_registry(config, address)


# -----------------------------------------------------------------------------
# Agent card and MCP dispatcher
# -----------------------------------------------------------------------------


class AgentRuntime:
    """
    Runtime state mirroring openemcp-clm/common/base_agent.py metrics.
    """

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self.running = False
        self.start_time: datetime | None = None
        self.request_count = 0
        self.error_count = 0

    def start(self) -> None:
        self.running = True
        self.start_time = datetime.now()

    def stop(self) -> None:
        self.running = False

    def uptime_seconds(self) -> float:
        if not self.start_time:
            return 0.0
        return (datetime.now() - self.start_time).total_seconds()

    def uptime_percentage(self) -> float:
        if not self.start_time:
            return 0.0
        running_time = self.uptime_seconds()
        return min(99.9, (running_time / (running_time + 1)) * 100)

    def reliability(self) -> float:
        if self.request_count == 0:
            return 1.0
        success_rate = (self.request_count - self.error_count) / self.request_count
        return max(0.0, min(1.0, success_rate))

    def health_payload(self) -> dict:
        return {
            "agent": self.agent_name,
            "status": "healthy" if self.running else "unhealthy",
            "uptime_percentage": self.uptime_percentage(),
            "reliability": self.reliability(),
            "running": self.running,
            "start_time": self.start_time.isoformat() if self.start_time else None,
        }

    def metrics_payload(self) -> dict:
        return {
            "agent": self.agent_name,
            "request_count": self.request_count,
            "error_count": self.error_count,
            "success_count": self.request_count - self.error_count,
            "reliability": self.reliability(),
            "uptime_seconds": self.uptime_seconds(),
            "uptime_percentage": self.uptime_percentage(),
        }


def build_agent_card(config: dict, mcp_spec: dict, host: str, port: int, use_mtls: bool = False) -> dict:
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
        "eago_phases": meta.get("eago_phases") or mcp_spec.get("open_eago", {}).get("eago_phases") or [],
        "tags": meta.get("tags") or [],
    }


def rpc_error(id_: Any, code: int, msg: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": msg}}


def rpc_result(id_: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def handle_mcp(
    body: dict,
    agent_card: dict,
    tools: dict,
    config: dict,
    port: int,
) -> dict:
    method = body.get("method")
    id_ = body.get("id")
    params = body.get("params") or {}

    if body.get("jsonrpc") != "2.0":
        return rpc_error(id_, -32600, "Invalid Request")

    if method == "initialize":
        return rpc_result(
            id_,
            {
                "protocolVersion": (config.get("mcp") or {}).get("protocol_version") or "2024-11-05",
                "serverInfo": {"name": agent_card["name"], "version": agent_card["version"]},
                "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
            },
        )
    if method == "notifications/initialized":
        return rpc_result(id_, None)

    if method == "tools/list":
        builtins = [
            {"name": "agent/info", "description": "Returns the agent card.", "inputSchema": {"type": "object", "properties": {}, "required": []}},
            {"name": "agent/ping", "description": "Health check – returns pong.", "inputSchema": {"type": "object", "properties": {}, "required": []}},
        ]
        custom = [
            {"name": n, "description": d["description"], "inputSchema": d["input_schema"]}
            for n, d in tools.items()
        ]
        return rpc_result(id_, {"tools": builtins + custom})

    if method == "tools/call":
        name = params.get("name")
        if name == "agent/info":
            return rpc_result(id_, {"content": [{"type": "text", "text": json.dumps(agent_card, indent=2)}]})
        if name == "agent/ping":
            return rpc_result(id_, {"content": [{"type": "text", "text": json.dumps({"status": "pong", "agent": agent_card["name"], "port": port})}]})
        if name not in tools:
            return rpc_error(id_, -32601, f"Unknown tool: {name}")
        try:
            result = tools[name]["handler"](params.get("arguments") or {})
            return rpc_result(id_, {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]})
        except Exception as e:
            return rpc_error(id_, -32000, f"Tool error: {e}")

    return rpc_error(id_, -32601, f"Method not found: {method}")


# -----------------------------------------------------------------------------
# HTTP(S) server with SPIRE mTLS
# -----------------------------------------------------------------------------


def make_ssl_context_server(spire: dict) -> ssl.SSLContext:
    """Server-side mTLS: present SVID, require client cert verified by bundle."""
    protocol = getattr(ssl, "PROTOCOL_TLS_SERVER", ssl.PROTOCOL_TLS)
    ctx = ssl.SSLContext(protocol)
    ctx.load_cert_chain(spire["cert_path"], spire["key_path"])
    ctx.load_verify_locations(cafile=spire["bundle_path"])
    ctx.verify_mode = ssl.CERT_REQUIRED  # require client cert
    return ctx


class MCPHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    agent_card: dict = {}
    tools: dict = {}
    config: dict = {}
    port: int = 9000
    runtime: AgentRuntime | None = None

    def _send_json(self, status: int, obj: Any) -> None:
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        # Keep things simple and avoid hanging clients: close after each response.
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        # openemcp-clm BaseAgent endpoints
        if self.path == "/health":
            rt = self.runtime
            payload = rt.health_payload() if rt else {"status": "unhealthy"}
            self._send_json(200, payload)
            return

        if self.path == "/metrics":
            rt = self.runtime
            payload = rt.metrics_payload() if rt else {}
            self._send_json(200, payload)
            return

        if self.path in ("/", "/.well-known/agent"):
            self._send_json(200, self.agent_card)
            return
        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        # openemcp-clm BaseAgent endpoint: POST /api/execute
        if self.path == "/api/execute":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            rt = self.runtime
            if rt:
                rt.request_count += 1
            try:
                data = json.loads(raw)
                if not isinstance(data, dict):
                    raise ValueError("request body must be a JSON object")

                # Demo execute(): echo + stamp
                result = {
                    **data,
                    "_agent": (rt.agent_name if rt else None),
                    "_handled_at": datetime.now().isoformat(),
                }
                self._send_json(200, result)
                return
            except Exception as e:
                if rt:
                    rt.error_count += 1
                self._send_json(500, {"error": str(e), "agent": (rt.agent_name if rt else None)})
                return

        if self.path != "/mcp":
            self._send_json(404, {"error": "Not found"})
            return
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else "{}"
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, rpc_error(None, -32700, "Parse error"))
            return
        is_batch = isinstance(parsed, list)
        reqs = parsed if is_batch else [parsed]
        resps = [handle_mcp(r, self.agent_card, self.tools, self.config, self.port) for r in reqs]
        self._send_json(200, resps if is_batch else resps[0])

    def log_message(self, format, *args):
        pass  # quiet by default; set to super().log_message for debug


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

    config = load_config(args)
    mcp_spec = load_mcp_spec()
    server_cfg = config.get("server") or {}
    host = server_cfg.get("host", "127.0.0.1")
    port = server_cfg.get("port", 9000)
    address = f"{host}:{port}"

    tools = build_tools_from_spec(mcp_spec, config)
    MCPHandler.tools = tools
    MCPHandler.config = config
    MCPHandler.port = port

    use_mtls = (config.get("spire") or {}).get("enabled") and not config.get("_allow_insecure")

    if use_mtls:
        spire = config.get("spire") or {}
        for key in ("cert_path", "key_path", "bundle_path"):
            p = spire.get(key)
            if not p or not Path(p).exists():
                print(f"SPIRE {key} not found at {p}. Run SPIRE and fetch SVID, or use --allow-insecure for dev.", file=sys.stderr)
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

    if config.get("_do_register") and ((config.get("bootstrap") or {}).get("urls")):
        register_with_registry(config, address)
        stop = threading.Event()
        t = threading.Thread(target=sync_loop, args=(config, address, stop), daemon=True)
        t.start()
        print(f"[demo-agent] Registry sync every {(config.get('bootstrap') or {}).get('sync_interval') or 30}s")
    elif config.get("_do_register"):
        print("[demo-agent] No bootstrap.urls configured; skip registration.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    runtime.stop()
    server.shutdown()


if __name__ == "__main__":
    main()
