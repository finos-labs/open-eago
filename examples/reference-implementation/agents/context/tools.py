"""Phase 5 - Context & State Management business logic.

Consolidates the prior phases' outputs into a session-level hierarchical
context record with full lineage (spec/v0.1.0/schemas/context-state-management.schema.json).
"""
from __future__ import annotations

import uuid


def handle_persist(args: dict) -> dict:
    session_id = args.get("session_id") or f"sess-{uuid.uuid4().hex[:12]}"
    lineage = args.get("lineage") or []
    contract = args.get("contract") or {}
    plan = args.get("plan") or {}
    validation = args.get("validation") or {}
    execution = args.get("execution") or {}

    state = {
        "session_id": session_id,
        "contract_id": contract.get("contract_id"),
        "plan_id": plan.get("plan_id"),
        "execution_id": execution.get("execution_id"),
        "risk_tier": (validation.get("risk_assessment") or {}).get("risk_tier"),
        "validation_status": validation.get("validation_status"),
        "execution_status": execution.get("status"),
        "sla_status": (execution.get("sla_compliance_status") or {}).get("overall_sla_status"),
    }

    return {
        "context_id": f"ctx-{uuid.uuid4().hex[:12]}",
        "level": "session",
        "state": state,
        "lineage": lineage,
        "ttl_seconds": 86400,
    }


TOOL_HANDLERS = {"context.persist": handle_persist}
