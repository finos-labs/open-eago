#!/usr/bin/env python3
"""
Conformance tests for demo_agent.py.

Runs the agent with --allow-insecure --no-register (no SPIRE, no registry needed).
Uses only stdlib: unittest, http.client, subprocess, threading, json.

Run:
  python -m pytest examples/agent-template/test_demo_agent.py -v
  # or without pytest:
  python -m unittest test_demo_agent -v
"""

import http.client
import json
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent
AGENT_SCRIPT = AGENT_DIR / "demo_agent.py"
HOST = "127.0.0.1"
PORT = 19001  # dedicated test port, avoids collision with dev port 9000
ADDRESS = f"{HOST}:{PORT}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post_mcp(payload: dict) -> tuple[int, dict]:
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    body = json.dumps(payload).encode()
    conn.request("POST", "/mcp", body=body, headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())


def _get(path: str) -> tuple[int, dict]:
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    conn.request("GET", path)
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())


def _post(path: str, payload: dict) -> tuple[int, dict]:
    conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
    body = json.dumps(payload).encode()
    conn.request("POST", path, body=body, headers={"Content-Type": "application/json"})
    resp = conn.getresponse()
    return resp.status, json.loads(resp.read())


# ---------------------------------------------------------------------------
# Test base: starts/stops one agent process per test class
# ---------------------------------------------------------------------------

class AgentTestCase(unittest.TestCase):
    _proc: subprocess.Popen | None = None

    @classmethod
    def setUpClass(cls) -> None:
        cls._proc = subprocess.Popen(
            [
                sys.executable, str(AGENT_SCRIPT),
                "--allow-insecure",
                "--no-register",
                f"--port={PORT}",
            ],
            cwd=str(AGENT_DIR),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait until the agent is accepting connections (max 5s).
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            try:
                conn = http.client.HTTPConnection(HOST, PORT, timeout=1)
                conn.request("GET", "/health")
                conn.getresponse()
                break
            except Exception:
                time.sleep(0.1)
        else:
            cls._proc.terminate()
            raise RuntimeError(f"Agent did not start on {ADDRESS} within 5s")

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._proc and cls._proc.poll() is None:
            cls._proc.send_signal(signal.SIGTERM)
            try:
                cls._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls._proc.kill()


# ---------------------------------------------------------------------------
# Group 1: HTTP supporting endpoints
# ---------------------------------------------------------------------------

class TestHTTPEndpoints(AgentTestCase):

    def test_health_returns_200(self):
        status, body = _get("/health")
        self.assertEqual(status, 200)

    def test_health_contains_status_healthy(self):
        _, body = _get("/health")
        self.assertEqual(body.get("status"), "healthy")

    def test_health_contains_reliability(self):
        _, body = _get("/health")
        r = body.get("reliability")
        self.assertIsNotNone(r)
        self.assertGreaterEqual(float(r), 0.0)
        self.assertLessEqual(float(r), 1.0)

    def test_health_contains_uptime_percentage(self):
        _, body = _get("/health")
        u = body.get("uptime_percentage")
        self.assertIsNotNone(u)
        self.assertGreaterEqual(float(u), 0.0)
        self.assertLessEqual(float(u), 100.0)

    def test_metrics_returns_200(self):
        status, _ = _get("/metrics")
        self.assertEqual(status, 200)

    def test_metrics_contains_reliability_and_uptime(self):
        _, body = _get("/metrics")
        self.assertIn("reliability", body)
        self.assertIn("uptime_percentage", body)

    def test_agent_card_root(self):
        status, body = _get("/")
        self.assertEqual(status, 200)
        self.assertIn("name", body)
        self.assertIn("version", body)

    def test_agent_card_well_known(self):
        status, body = _get("/.well-known/agent")
        self.assertEqual(status, 200)
        self.assertIn("open_eago", body)
        self.assertIn("eago_phases", body)

    def test_unknown_path_returns_404(self):
        status, _ = _get("/does-not-exist")
        self.assertEqual(status, 404)

    def test_execute_echoes_payload(self):
        status, body = _post("/api/execute", {"foo": "bar", "counter": 1})
        self.assertEqual(status, 200)
        self.assertEqual(body.get("foo"), "bar")
        self.assertIn("_agent", body)
        self.assertIn("_handled_at", body)


# ---------------------------------------------------------------------------
# Group 2: MCP protocol conformance
# ---------------------------------------------------------------------------

class TestMCPProtocol(AgentTestCase):

    def test_initialize_returns_protocol_version(self):
        status, body = _post_mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertEqual(status, 200)
        result = body.get("result", {})
        self.assertIn("protocolVersion", result)
        self.assertIn("serverInfo", result)
        self.assertIn("capabilities", result)

    def test_initialize_capabilities_contains_tools(self):
        _, body = _post_mcp({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertIn("tools", body["result"]["capabilities"])

    def test_tools_list_returns_at_least_one_tool(self):
        status, body = _post_mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        self.assertEqual(status, 200)
        tools = body.get("result", {}).get("tools", [])
        self.assertGreater(len(tools), 0)

    def test_tools_list_includes_agent_ping(self):
        _, body = _post_mcp({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        names = [t["name"] for t in body["result"]["tools"]]
        self.assertIn("agent/ping", names)

    def test_tools_call_agent_ping(self):
        _, body = _post_mcp({
            "jsonrpc": "2.0", "id": 3,
            "method": "tools/call",
            "params": {"name": "agent/ping", "arguments": {}},
        })
        text = body["result"]["content"][0]["text"]
        result = json.loads(text)
        self.assertEqual(result.get("status"), "pong")

    def test_tools_call_agent_info(self):
        _, body = _post_mcp({
            "jsonrpc": "2.0", "id": 4,
            "method": "tools/call",
            "params": {"name": "agent/info", "arguments": {}},
        })
        text = body["result"]["content"][0]["text"]
        card = json.loads(text)
        self.assertIn("name", card)
        self.assertIn("eago_phases", card)

    def test_tools_call_eago_health(self):
        _, body = _post_mcp({
            "jsonrpc": "2.0", "id": 5,
            "method": "tools/call",
            "params": {"name": "eago_health", "arguments": {}},
        })
        text = body["result"]["content"][0]["text"]
        result = json.loads(text)
        self.assertEqual(result.get("status"), "ok")
        self.assertIn("eago_phases", result)

    def test_unknown_tool_returns_error(self):
        _, body = _post_mcp({
            "jsonrpc": "2.0", "id": 6,
            "method": "tools/call",
            "params": {"name": "does-not-exist", "arguments": {}},
        })
        self.assertIn("error", body)
        self.assertEqual(body["error"]["code"], -32601)

    def test_unknown_method_returns_error(self):
        _, body = _post_mcp({"jsonrpc": "2.0", "id": 7, "method": "unknown/method", "params": {}})
        self.assertIn("error", body)
        self.assertEqual(body["error"]["code"], -32601)

    def test_invalid_jsonrpc_version_returns_error(self):
        _, body = _post_mcp({"jsonrpc": "1.0", "id": 8, "method": "tools/list", "params": {}})
        self.assertIn("error", body)
        self.assertEqual(body["error"]["code"], -32600)

    def test_invalid_json_returns_400(self):
        conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
        conn.request("POST", "/mcp", body=b"not json", headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 400)

    def test_batch_request_returns_array(self):
        batch = [
            {"jsonrpc": "2.0", "id": 10, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 11, "method": "tools/list", "params": {}},
        ]
        conn = http.client.HTTPConnection(HOST, PORT, timeout=5)
        body = json.dumps(batch).encode()
        conn.request("POST", "/mcp", body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        result = json.loads(resp.read())
        self.assertIsInstance(result, list)
        self.assertEqual(len(result), 2)

    def test_resources_list_returns_list(self):
        _, body = _post_mcp({"jsonrpc": "2.0", "id": 20, "method": "resources/list", "params": {}})
        self.assertIn("result", body)
        self.assertIn("resources", body["result"])
        self.assertIsInstance(body["result"]["resources"], list)

    def test_prompts_list_returns_list(self):
        _, body = _post_mcp({"jsonrpc": "2.0", "id": 21, "method": "prompts/list", "params": {}})
        self.assertIn("result", body)
        self.assertIn("prompts", body["result"])
        self.assertIsInstance(body["result"]["prompts"], list)

    def test_resources_read_unknown_returns_error(self):
        _, body = _post_mcp({
            "jsonrpc": "2.0", "id": 22,
            "method": "resources/read",
            "params": {"uri": "urn:does-not-exist"},
        })
        self.assertIn("error", body)
        self.assertEqual(body["error"]["code"], -32601)

    def test_prompts_get_unknown_returns_error(self):
        _, body = _post_mcp({
            "jsonrpc": "2.0", "id": 23,
            "method": "prompts/get",
            "params": {"name": "does-not-exist"},
        })
        self.assertIn("error", body)
        self.assertEqual(body["error"]["code"], -32601)


# ---------------------------------------------------------------------------
# Group 3: Config validation
# ---------------------------------------------------------------------------

class TestConfigValidation(unittest.TestCase):
    """Runs the agent with deliberately invalid configs and checks it exits with error."""

    def _run_agent(self, extra_env: dict) -> subprocess.CompletedProcess:
        env = {**os.environ, **extra_env}
        return subprocess.run(
            [sys.executable, str(AGENT_SCRIPT), "--allow-insecure", "--no-register", f"--port={PORT + 1}"],
            cwd=str(AGENT_DIR),
            capture_output=True,
            text=True,
            timeout=5,
            env=env,
        )

    def test_invalid_phase_causes_exit(self):
        """Patch config by writing a temp config with a bad phase value."""
        import tempfile, yaml
        bad_config = {
            "metadata": {
                "name": "test-agent",
                "version": "0.1.0",
                "eago_phases": ["not_a_real_phase"],
            }
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", dir=str(AGENT_DIR), delete=False
        ) as f:
            yaml.dump(bad_config, f)
            tmp_path = f.name
        try:
            result = subprocess.run(
                [sys.executable, str(AGENT_SCRIPT), "--allow-insecure", "--no-register",
                 f"--port={PORT + 1}", f"--config={tmp_path}"],
                cwd=str(AGENT_DIR),
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("not_a_real_phase", result.stderr)
        finally:
            Path(tmp_path).unlink(missing_ok=True)

    def test_invalid_reliability_causes_exit(self):
        import tempfile, yaml
        bad_config = {
            "metadata": {"name": "test-agent", "version": "0.1.0"},
            "agent": {"reliability": 1.5},
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".yaml", dir=str(AGENT_DIR), delete=False
        ) as f:
            yaml.dump(bad_config, f)
            tmp_path = f.name
        try:
            result = subprocess.run(
                [sys.executable, str(AGENT_SCRIPT), "--allow-insecure", "--no-register",
                 f"--port={PORT + 1}", f"--config={tmp_path}"],
                cwd=str(AGENT_DIR),
                capture_output=True,
                text=True,
                timeout=5,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("reliability", result.stderr)
        finally:
            Path(tmp_path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
