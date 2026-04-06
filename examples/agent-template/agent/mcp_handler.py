"""MCP JSON-RPC dispatcher and HTTP(S) request handler."""
from __future__ import annotations

import json
import ssl
from datetime import datetime
from http.server import BaseHTTPRequestHandler
from typing import TYPE_CHECKING, Any

from agent.envelope import (
    EnvelopeValidationError,
    envelope_validation_error_body,
    unwrap_envelope,
    wrap_envelope,
)

if TYPE_CHECKING:
    from agent.runtime import AgentRuntime


def rpc_error(id_: Any, code: int, msg: str) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": msg}}


def rpc_result(id_: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def handle_mcp(
    body: dict,
    agent_card: dict,
    tools: dict,
    resources: dict,
    prompts: dict,
    config: dict,
    port: int,
) -> dict:
    method = body.get("method")
    id_ = body.get("id")
    params = body.get("params") or {}

    if body.get("jsonrpc") != "2.0":
        return rpc_error(id_, -32600, "Invalid Request")

    if method == "initialize":
        caps: dict = {"tools": {}}
        if resources:
            caps["resources"] = {}
        if prompts:
            caps["prompts"] = {}
        return rpc_result(
            id_,
            {
                "protocolVersion": (config.get("mcp") or {}).get("protocol_version") or "2024-11-05",
                "serverInfo": {"name": agent_card["name"], "version": agent_card["version"]},
                "capabilities": caps,
            },
        )

    if method == "notifications/initialized":
        return rpc_result(id_, None)

    # --- tools ---
    if method == "tools/list":
        builtins = [
            {
                "name": "agent/info",
                "description": "Returns the agent card.",
                "inputSchema": {"type": "object", "properties": {}, "required": []},
            },
            {
                "name": "agent/ping",
                "description": "Health check – returns pong.",
                "inputSchema": {"type": "object", "properties": {}, "required": []},
            },
        ]
        custom = [
            {"name": n, "description": d["description"], "inputSchema": d["input_schema"]}
            for n, d in tools.items()
        ]
        return rpc_result(id_, {"tools": builtins + custom})

    if method == "tools/call":
        name = params.get("name")
        if name == "agent/info":
            return rpc_result(
                id_,
                {"content": [{"type": "text", "text": json.dumps(agent_card, indent=2)}]},
            )
        if name == "agent/ping":
            return rpc_result(
                id_,
                {
                    "content": [
                        {
                            "type": "text",
                            "text": json.dumps(
                                {"status": "pong", "agent": agent_card["name"], "port": port}
                            ),
                        }
                    ]
                },
            )
        if name not in tools:
            return rpc_error(id_, -32601, f"Unknown tool: {name}")
        try:
            result = tools[name]["handler"](params.get("arguments") or {})
            return rpc_result(
                id_,
                {"content": [{"type": "text", "text": json.dumps(result, indent=2)}]},
            )
        except Exception as e:
            return rpc_error(id_, -32000, f"Tool error: {e}")

    # --- resources ---
    if method == "resources/list":
        return rpc_result(
            id_,
            {
                "resources": [
                    {
                        "uri": uri,
                        "name": r["name"],
                        "description": r["description"],
                        "mimeType": r["mime_type"],
                    }
                    for uri, r in resources.items()
                ]
            },
        )

    if method == "resources/read":
        uri = params.get("uri")
        if uri not in resources:
            return rpc_error(id_, -32601, f"Unknown resource: {uri}")
        r = resources[uri]
        return rpc_result(
            id_,
            {"contents": [{"uri": uri, "mimeType": r["mime_type"], "text": r["contents"]}]},
        )

    # --- prompts ---
    if method == "prompts/list":
        return rpc_result(
            id_,
            {
                "prompts": [
                    {"name": n, "description": p["description"], "arguments": p["arguments"]}
                    for n, p in prompts.items()
                ]
            },
        )

    if method == "prompts/get":
        name = params.get("name")
        if name not in prompts:
            return rpc_error(id_, -32601, f"Unknown prompt: {name}")
        p = prompts[name]
        return rpc_result(id_, {"description": p["description"], "messages": p["messages"]})

    return rpc_error(id_, -32601, f"Method not found: {method}")


def make_ssl_context_server(spire: dict) -> ssl.SSLContext:
    """Server-side mTLS: present SVID, require client cert verified by bundle."""
    protocol = getattr(ssl, "PROTOCOL_TLS_SERVER", ssl.PROTOCOL_TLS)
    ctx = ssl.SSLContext(protocol)
    ctx.load_cert_chain(spire["cert_path"], spire["key_path"])
    ctx.load_verify_locations(cafile=spire["bundle_path"])
    ctx.verify_mode = ssl.CERT_REQUIRED  # require client cert
    return ctx


def dispatch_mcp_requests(
    parsed: dict | list,
    agent_card: dict,
    tools: dict,
    resources: dict,
    prompts: dict,
    config: dict,
    port: int,
) -> dict | list:
    is_batch = isinstance(parsed, list)
    reqs = parsed if is_batch else [parsed]
    resps: list[dict] = []
    for req in reqs:
        if not isinstance(req, dict):
            resps.append(rpc_error(None, -32600, "Invalid Request"))
            continue
        resps.append(
            handle_mcp(
                req,
                agent_card,
                tools,
                resources,
                prompts,
                config,
                port,
            )
        )
    return resps if is_batch else resps[0]


class MCPHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    agent_card: dict = {}
    tools: dict = {}
    resources: dict = {}
    prompts: dict = {}
    config: dict = {}
    port: int = 9000
    runtime: "AgentRuntime | None" = None

    def _get_caller_spiffe_id(self) -> str | None:
        """Extract SPIFFE ID (URI SAN) from the peer's TLS client certificate, if present."""
        try:
            cert = self.connection.getpeercert()  # type: ignore[attr-defined]
            for san_type, san_value in cert.get("subjectAltName", []):
                if san_type == "URI" and san_value.startswith("spiffe://"):
                    return san_value
        except Exception:
            pass
        return None

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
        caller = self._get_caller_spiffe_id()
        if caller:
            print(f"[demo-agent] GET {self.path} caller={caller}")
            if self.runtime:
                self.runtime.record_caller(caller)

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
        caller = self._get_caller_spiffe_id()
        if caller:
            print(f"[demo-agent] POST {self.path} caller={caller}")
            if self.runtime:
                self.runtime.record_caller(caller)

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

        mcp_cfg = self.config.get("mcp") or {}
        use_envelope = bool(mcp_cfg.get("eago_envelope"))

        if use_envelope:
            try:
                payload, env_ctx = unwrap_envelope(parsed)
            except EnvelopeValidationError as e:
                self._send_json(400, envelope_validation_error_body(str(e)))
                return

            rpc_response = dispatch_mcp_requests(
                payload,
                self.agent_card,
                self.tools,
                self.resources,
                self.prompts,
                self.config,
                self.port,
            )
            wrapped = wrap_envelope(
                rpc_response,
                phase=env_ctx["phase"],
                correlation_id=env_ctx["message_id"],
            )
            self._send_json(200, wrapped)
            return

        rpc_response = dispatch_mcp_requests(
            parsed,
            self.agent_card,
            self.tools,
            self.resources,
            self.prompts,
            self.config,
            self.port,
        )
        self._send_json(200, rpc_response)

    def log_message(self, format, *args):
        pass  # quiet by default; set to super().log_message for debug
