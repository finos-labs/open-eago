#!/usr/bin/env python3
"""Smoke test: start all six phase agents standalone (no registry) and drive one
golden-path execution end-to-end through their MCP tools, validating each
schema-conformant artifact against spec/v0.1.0/schemas/*.

Usage: .venv/bin/python3 scripts/smoke_test_agents.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[3]
REFIMPL_ROOT = Path(__file__).resolve().parents[1]
SCHEMAS_DIR = REPO_ROOT / "spec" / "v0.1.0" / "schemas"

AGENTS = [
    ("contract", 9001),
    ("planning", 9002),
    ("validation", 9003),
    ("execution", 9004),
    ("context", 9005),
    ("communication", 9006),
]


def strip_internal(obj):
    if isinstance(obj, dict):
        return {k: strip_internal(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [strip_internal(v) for v in obj]
    return obj


def call_tool(port: int, phase: str, tool_name: str, arguments: dict) -> dict:
    body = {
        "message_id": f"msg-{uuid4()}",
        "spec_version": "0.1.0",
        "phase": phase,
        "timestamp": "2026-06-18T10:00:00Z",
        "payload": {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        },
    }
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/mcp",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        envelope = json.loads(resp.read().decode("utf-8"))
    rpc_result = envelope["payload"]["result"]
    text = rpc_result["content"][0]["text"]
    return json.loads(text)


def wait_healthy(port: int, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1) as resp:
                if resp.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError):
            pass
        time.sleep(0.3)
    raise RuntimeError(f"agent on port {port} did not become healthy in {timeout}s")


def validate(schema_name: str, doc: dict) -> None:
    import jsonschema

    schema = json.loads((SCHEMAS_DIR / schema_name).read_text())
    jsonschema.Draft202012Validator(schema).validate(strip_internal(doc))


def main() -> int:
    venv_python = REFIMPL_ROOT / ".venv" / "bin" / "python3"
    procs: list[subprocess.Popen] = []
    log_dir = REFIMPL_ROOT / "scripts" / ".smoke_logs"
    log_dir.mkdir(exist_ok=True)

    try:
        for name, port in AGENTS:
            agent_dir = REFIMPL_ROOT / "agents" / name
            log_path = log_dir / f"{name}.log"
            proc = subprocess.Popen(
                [str(venv_python), "server.py", "--allow-insecure", "--no-register"],
                cwd=agent_dir,
                stdout=open(log_path, "w"),
                stderr=subprocess.STDOUT,
            )
            procs.append(proc)

        for name, port in AGENTS:
            wait_healthy(port)
            print(f"[ok] {name} agent healthy on :{port}")

        # --- Drive one golden-path execution through the real MCP tools ---
        task_data = {
            "customer_id": "CUST-SMOKE-1",
            "new_address": {"country": "GB"},
            "account_value": 2000,
            "verification_documents": [{"type": "passport"}, {"type": "utility_bill"}],
        }

        contract = call_tool(
            9001, "contract_management", "contract.process",
            {
                "objective": "Update customer address",
                "task_data": task_data,
                "source_context": {"application_id": "smoke-test"},
            },
        )
        validate("contract-management.schema.json", contract)
        print("[ok] contract-management.schema.json valid")

        plan = call_tool(9002, "planning_negotiation", "planning.plan", {"contract": contract, "task_data": task_data})
        validate("planning-negotiation.schema.json", plan)
        print("[ok] planning-negotiation.schema.json valid")

        draft = call_tool(
            9003, "validation_compliance", "validation.assess",
            {"plan": plan, "contract": contract, "task_data": task_data},
        )
        # Assemble the canonical document the orchestrator would persist (auto-approved path).
        validation_doc = {
            "plan_id": draft["plan_id"],
            "validation_status": draft["validation_status_recommendation"] or "approved",
            "policy_checks": draft["policy_checks"],
            "compliance_profiles": draft["compliance_profiles"],
            "hitl": {"required": True, "decision": draft["validation_status_recommendation"] or "approved", "decision_at": "2026-06-18T10:00:01Z"},
            "risk_assessment": draft["risk_assessment"],
        }
        validate("validation-compliance.schema.json", validation_doc)
        print("[ok] validation-compliance.schema.json valid")

        execution = call_tool(
            9004, "execution_resilience", "execution.run",
            {"plan": plan, "validation": validation_doc, "contract": contract, "task_data": task_data},
        )
        validate("execution-resilience.schema.json", execution)
        print("[ok] execution-resilience.schema.json valid")

        context = call_tool(
            9005, "context_state_management", "context.persist",
            {
                "session_id": f"sess-{uuid4().hex[:12]}",
                "lineage": ["contract_management", "planning_negotiation", "validation_compliance", "execution_resilience"],
                "contract": contract, "plan": plan, "validation": validation_doc, "execution": execution,
            },
        )
        validate("context-state-management.schema.json", context)
        print("[ok] context-state-management.schema.json valid")

        communication = call_tool(
            9006, "communication_delivery", "communication.deliver",
            {"recipient": task_data["customer_id"], "outcome_status": "approved", "audit_ref": context["context_id"]},
        )
        validate("communication-delivery.schema.json", communication)
        print("[ok] communication-delivery.schema.json valid")

        print("\nSMOKE TEST PASSED: all six phase agents produce schema-conformant artifacts.")
        return 0

    except Exception as e:
        print(f"\nSMOKE TEST FAILED: {e}", file=sys.stderr)
        for name, _ in AGENTS:
            log_path = log_dir / f"{name}.log"
            if log_path.exists() and log_path.stat().st_size:
                print(f"--- {name}.log ---", file=sys.stderr)
                print(log_path.read_text()[-2000:], file=sys.stderr)
        return 1

    finally:
        for proc in procs:
            proc.terminate()
        for proc in procs:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    sys.exit(main())
