"""OpenEAGO six-phase pipeline: LangGraph StateGraph wiring discovery, enveloped
MCP calls, schema validation, Mongo persistence, and WebSocket broadcast around
each of the six reference agents.

Phase 3 (Validation & Compliance) carries a mandatory HITL gate: low/medium
risk is auto-decided immediately, high/critical risk pauses the graph (the
`compiled_full` graph routes straight to END) until a human calls the
/hitl-decision endpoint, which resumes via `compiled_resume`. Both graphs
share the same node functions - no logic duplication between the two paths.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, TypedDict
from uuid import uuid4

from langgraph.graph import END, StateGraph

from app import persistence, registry_client
from app.mcp_client import call_tool
from app.schema_validation import strip_internal, validate_phase
from app.ws_hub import hub

logger = logging.getLogger("orchestrator.workflow")

PHASE_LINEAGE = [
    "contract_management",
    "planning_negotiation",
    "validation_compliance",
    "execution_resilience",
    "context_state_management",
    "communication_delivery",
]


class PipelineState(TypedDict, total=False):
    execution_id: str
    session_id: str
    task_data: dict
    contract: dict
    plan: dict
    validation_draft: dict
    validation: dict
    execution: dict
    context: dict
    communication: dict
    outcome: str  # "proceed" | "rejected" | "awaiting_hitl"


async def _call_phase_agent(
    execution_id: str, phase: str, tool_name: str, arguments: dict
) -> dict:
    agent = await registry_client.discover(phase)
    if not agent:
        raise RuntimeError(f"no healthy agent registered for capability '{phase}'")
    http_endpoint = (agent.get("endpoints") or {}).get("http")
    if not http_endpoint:
        raise RuntimeError(f"agent for '{phase}' has no http endpoint")

    result, _envelope = await call_tool(http_endpoint, phase, tool_name, arguments, correlation_id=execution_id)
    conformant, errors = validate_phase(phase, result)
    if not conformant:
        logger.warning("phase %s produced non-conformant document: %s", phase, errors)
    event = await persistence.save_phase(execution_id, phase, result, conformant, errors)
    await hub.broadcast(event)
    return strip_internal(result)


async def node_contract(state: PipelineState) -> dict:
    task_data = state["task_data"]
    contract = await _call_phase_agent(
        state["execution_id"], "contract_management", "contract.process",
        {
            "objective": task_data.get("objective", "Process task request"),
            "task_data": task_data,
            "source_context": {"application_id": "eago-reference-dashboard"},
            "constraints": task_data.get("constraints", {}),
        },
    )
    return {"contract": contract}


async def node_planning(state: PipelineState) -> dict:
    plan = await _call_phase_agent(
        state["execution_id"], "planning_negotiation", "planning.plan",
        {"contract": state["contract"], "task_data": state["task_data"]},
    )
    return {"plan": plan}


async def node_validation(state: PipelineState) -> dict:
    execution_id = state["execution_id"]
    agent = await registry_client.discover("validation_compliance")
    if not agent:
        raise RuntimeError("no healthy agent registered for capability 'validation_compliance'")
    http_endpoint = (agent.get("endpoints") or {}).get("http")
    draft, _envelope = await call_tool(
        http_endpoint, "validation_compliance", "validation.assess",
        {"plan": state["plan"], "contract": state["contract"], "task_data": state["task_data"]},
        correlation_id=execution_id,
    )
    await persistence.save_validation_draft(execution_id, draft)

    escalation_outcome = draft["risk_assessment"]["escalation_outcome"]

    if escalation_outcome == "hitl_pending":
        event = await persistence.set_status(execution_id, "awaiting_hitl")
        await hub.broadcast(event)
        return {"validation_draft": draft, "outcome": "awaiting_hitl"}

    decision = "rejected" if escalation_outcome == "rejected" else "approved"
    validation_doc = finalize_validation_document(draft, decision, reviewer_id=None)
    conformant, errors = validate_phase("validation_compliance", validation_doc)
    event = await persistence.save_phase(execution_id, "validation_compliance", validation_doc, conformant, errors)
    await hub.broadcast(event)

    return {
        "validation": strip_internal(validation_doc),
        "outcome": "rejected" if decision == "rejected" else "proceed",
    }


def finalize_validation_document(draft: dict, decision: str, reviewer_id: str | None) -> dict:
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    hitl: dict[str, Any] = {"required": True, "decision": decision, "decision_at": now}
    if reviewer_id:
        hitl["reviewer_id"] = reviewer_id
    return {
        "plan_id": draft["plan_id"],
        "validation_status": decision,
        "policy_checks": draft["policy_checks"],
        "compliance_profiles": draft["compliance_profiles"],
        "hitl": hitl,
        "risk_assessment": draft["risk_assessment"],
    }


async def node_execution(state: PipelineState) -> dict:
    execution = await _call_phase_agent(
        state["execution_id"], "execution_resilience", "execution.run",
        {
            "plan": state["plan"], "validation": state["validation"],
            "contract": state["contract"], "task_data": state["task_data"],
        },
    )
    return {"execution": execution}


async def node_context(state: PipelineState) -> dict:
    lineage = PHASE_LINEAGE[: PHASE_LINEAGE.index("execution_resilience") + 1]
    context = await _call_phase_agent(
        state["execution_id"], "context_state_management", "context.persist",
        {
            "session_id": state["session_id"], "lineage": lineage,
            "contract": state["contract"], "plan": state["plan"],
            "validation": state["validation"], "execution": state.get("execution", {}),
        },
    )
    return {"context": context}


async def node_communication(state: PipelineState) -> dict:
    execution_id = state["execution_id"]
    task_data = state["task_data"]
    validation = state["validation"]
    context = state.get("context") or {}

    communication = await _call_phase_agent(
        execution_id, "communication_delivery", "communication.deliver",
        {
            "recipient": task_data.get("customer_id", "unknown-customer"),
            "outcome_status": validation["validation_status"],
            "audit_ref": context.get("context_id"),
        },
    )
    final_status = "completed" if validation["validation_status"] in ("approved", "modified") else "rejected"
    event = await persistence.set_status(execution_id, final_status)
    await hub.broadcast(event)
    return {"communication": communication}


def _route_after_validation(state: PipelineState) -> str:
    return {"proceed": "execution", "rejected": "communication", "awaiting_hitl": END}[state["outcome"]]


def _build_full_graph():
    graph = StateGraph(PipelineState)
    graph.add_node("contract", node_contract)
    graph.add_node("planning", node_planning)
    graph.add_node("validation", node_validation)
    graph.add_node("execution", node_execution)
    graph.add_node("context", node_context)
    graph.add_node("communication", node_communication)

    graph.set_entry_point("contract")
    graph.add_edge("contract", "planning")
    graph.add_edge("planning", "validation")
    graph.add_conditional_edges(
        "validation", _route_after_validation,
        {"execution": "execution", "communication": "communication", END: END},
    )
    graph.add_edge("execution", "context")
    graph.add_edge("context", "communication")
    graph.add_edge("communication", END)
    return graph.compile()


def _build_resume_graph():
    graph = StateGraph(PipelineState)
    graph.add_node("execution", node_execution)
    graph.add_node("context", node_context)
    graph.add_node("communication", node_communication)
    graph.set_entry_point("execution")
    graph.add_edge("execution", "context")
    graph.add_edge("context", "communication")
    graph.add_edge("communication", END)
    return graph.compile()


compiled_full = _build_full_graph()
compiled_resume = _build_resume_graph()


async def start_execution(task_data: dict, scenario: str | None = None) -> tuple[str, str]:
    """Create the execution record and return (execution_id, session_id) immediately.
    Call run_graph_background() separately (e.g. via asyncio.create_task) to drive it."""
    execution_id = f"exec-{uuid4().hex[:12]}"
    session_id = f"sess-{uuid4().hex[:12]}"
    await persistence.create_execution(execution_id, session_id, task_data, scenario)
    return execution_id, session_id


async def run_graph_background(execution_id: str, session_id: str, task_data: dict) -> None:
    initial_state: PipelineState = {
        "execution_id": execution_id, "session_id": session_id, "task_data": task_data,
    }
    try:
        await compiled_full.ainvoke(initial_state)
    except Exception as e:
        logger.exception("pipeline failed for %s", execution_id)
        event = await persistence.set_status(execution_id, "failed", {"error": str(e)})
        await hub.broadcast(event)


async def finalize_hitl_decision(execution_id: str, decision: str, reviewer_id: str | None) -> PipelineState:
    """Synchronous (fast) half of HITL resume: validates the request and records
    the finalized validation-compliance document. Raises ValueError on bad input
    so the REST layer can return 400/404 instead of a generic 500."""
    doc = await persistence.get_execution(execution_id)
    if doc is None:
        raise ValueError(f"unknown execution_id {execution_id}")
    if doc["status"] != "awaiting_hitl":
        raise ValueError(f"execution {execution_id} is not awaiting a HITL decision (status={doc['status']})")

    draft = doc["validation_draft"]
    validation_doc = finalize_validation_document(draft, decision, reviewer_id)
    conformant, errors = validate_phase("validation_compliance", validation_doc)
    event = await persistence.save_phase(execution_id, "validation_compliance", validation_doc, conformant, errors)
    await hub.broadcast(event)

    state: PipelineState = {
        "execution_id": execution_id,
        "session_id": doc["session_id"],
        "task_data": doc["task_data"],
        "contract": (doc["phases"].get("contract_management") or {}).get("document", {}),
        "plan": (doc["phases"].get("planning_negotiation") or {}).get("document", {}),
        "validation": strip_internal(validation_doc),
    }

    status_event = await persistence.set_status(execution_id, "running")
    await hub.broadcast(status_event)
    return state


async def continue_after_hitl_background(execution_id: str, decision: str, state: PipelineState) -> None:
    """Slow (network-bound) half of HITL resume - run as a background task so the
    REST endpoint can return as soon as the decision is recorded."""
    try:
        if decision == "rejected":
            await node_communication(state)
        else:
            await compiled_resume.ainvoke(state)
    except Exception as e:
        logger.exception("post-HITL pipeline failed for %s", execution_id)
        event = await persistence.set_status(execution_id, "failed", {"error": str(e)})
        await hub.broadcast(event)
