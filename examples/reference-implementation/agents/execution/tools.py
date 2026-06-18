"""Phase 4 - Execution & Resilience business logic.

Runs the approved plan and drives the SLA breach state machine
(spec/v0.1.0/schemas/execution-resilience.schema.json), propagating the
Phase 3 risk context forward as required by docs/overview/risk-management.md.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone


def handle_run(args: dict) -> dict:
    plan = args.get("plan") or {}
    validation = args.get("validation") or {}
    contract = args.get("contract") or {}
    task_data = args.get("task_data") or {}

    target_p99_ms = ((plan.get("sla_guarantees") or {}).get("latency") or {}).get("p99_ms", 800.0)
    simulate_latency_ms = float(task_data.get("simulate_latency_ms") or 0)
    observed_p99_ms = simulate_latency_ms if simulate_latency_ms > 0 else round(target_p99_ms * 0.4, 1)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    breach_events: list[dict] = []

    if observed_p99_ms > target_p99_ms * 1.5:
        latency_status = "breached"
        breach_state = "fallback_activated"
        overall_sla_status = "breached"
        resilience = {"circuit_breaker": True, "fallback_used": True, "compensation_applied": False}
        circuit_breaker_trips = 1
        breach_events = [
            {
                "event_type": "slo_breach",
                "event_timestamp": now,
                "breached_slo": "latency_p99_ms",
                "slo_target": target_p99_ms,
                "sli_observed": observed_p99_ms,
                "breach_response": "activate_fallback",
            }
        ]
    elif observed_p99_ms > target_p99_ms:
        latency_status = "at_risk"
        breach_state = "at_risk"
        overall_sla_status = "met"
        resilience = {"circuit_breaker": False, "fallback_used": False, "compensation_applied": False}
        circuit_breaker_trips = 0
    else:
        latency_status = "met"
        breach_state = "completed"
        overall_sla_status = "met"
        resilience = {"circuit_breaker": False, "fallback_used": False, "compensation_applied": False}
        circuit_breaker_trips = 0

    tasks = [
        {"task_id": f"task-{i + 1}", "status": "completed", "capability": cap}
        for i, cap in enumerate(contract.get("requested_capabilities") or ["generic_task"])
    ]

    risk_assessment = validation.get("risk_assessment") or {}

    return {
        "execution_id": f"exec-{uuid.uuid4().hex[:12]}",
        "plan_id": plan.get("plan_id"),
        "status": "completed",
        "tasks": tasks,
        "resilience": resilience,
        "sla_compliance_status": {
            "breach_state": breach_state,
            "overall_sla_status": overall_sla_status,
            "circuit_breaker_trips": circuit_breaker_trips,
            "slo_results": {
                "latency_p99_ms": {
                    "target": target_p99_ms,
                    "observed": observed_p99_ms,
                    "status": latency_status,
                },
                "availability_pct": {"target": 0.999, "observed": 0.999, "status": "met"},
            },
            **({"breach_events": breach_events} if breach_events else {}),
        },
        "risk_context": {
            "composite_risk_score": risk_assessment.get("composite_risk_score", 0.0),
            "risk_tier": risk_assessment.get("risk_tier", "low"),
            "circuit_breaker_trips": circuit_breaker_trips,
        },
    }


TOOL_HANDLERS = {"execution.run": handle_run}
