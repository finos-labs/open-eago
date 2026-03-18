"""
credit_node.py — LangGraph node: CREDIT_NODE

Handles all credit review statuses with the counter-proposal loop:
  "pending"          → assess_credit → propose_terms / request_documents / submit_recommendation
  "data_requested"   → interrupt (wait for DataFulfilled)
  "terms_proposed"   → interrupt (wait for CounterProposed or AcceptTerms)
  "counter_proposed" → continue_assessment(trigger='counter_proposed') → loop or accept
  "approved"/"rejected"/"error" → terminal
"""

from __future__ import annotations

import logging

from langgraph.types import interrupt

from shared.bridge_base import call_mcp_tool
from graph.onboarding_state import OnboardingState

logger = logging.getLogger(__name__)

CREDIT_MCP_ENDPOINT = "http://localhost:8011"


async def credit_node(state: OnboardingState) -> dict:
    flow_id    = state["flow_id"]
    status     = state.get("credit_status", "pending")
    request_id = state.get("credit_request_id") or ""
    trace_id   = state.get("trace_id", flow_id)
    round_n    = state.get("credit_negotiation_round", 0)

    logger.info("[credit-node] flow=%s status=%s round=%d", flow_id, status, round_n)

    if status == "pending":
        result = await call_mcp_tool(
            CREDIT_MCP_ENDPOINT, "assess_credit",
            {
                "flow_id":         flow_id,
                "request_id":      request_id,
                "client_agent_id": state.get("hf_credit_agent_id", "8"),
            },
            trace_id,
        )
        return _handle_credit_result(result, round_n)

    if status in ("data_requested", "terms_proposed"):
        # Pause: wait for DataFulfilled or CounterProposed event
        interrupt(f"credit: waiting for event (status={status})")
        return {}

    if status == "counter_proposed":
        # Resume after CounterProposed event was injected
        data_hash = state.get("credit_terms_hash") or ""
        result = await call_mcp_tool(
            CREDIT_MCP_ENDPOINT, "continue_assessment",
            {
                "flow_id":       flow_id,
                "request_id":    request_id,
                "trigger":       "counter_proposed",
                "data_hash":     data_hash,
                "current_round": round_n,
            },
            trace_id,
        )
        return _handle_credit_result(result, round_n)

    # Terminal states
    return {}


def _handle_credit_result(result: dict, round_n: int) -> dict:
    action = result.get("action")

    if action == "request_documents":
        return {
            "credit_status": "data_requested",
            "credit_negotiation_round": round_n + 1,
        }
    if action == "propose_terms":
        return {
            "credit_status":    "terms_proposed",
            "credit_terms_hash": result.get("terms_hash"),
            "credit_negotiation_round": round_n + 1,
        }
    if action == "accept_terms":
        return {
            "credit_status":    "approved",
            "credit_terms_hash": result.get("agreed_hash"),
        }
    if action == "submit_recommendation":
        approved = result.get("approved", True)
        return {
            "credit_status":    "approved" if approved else "rejected",
            "credit_terms_hash": result.get("result_hash"),
        }
    return {"credit_status": "error"}
