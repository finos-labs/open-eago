"""
aml_node.py — LangGraph node: AML_NODE

Handles all AML review statuses:
  "pending"        → call screen_client → request_documents or submit_recommendation
  "data_requested" → wait for DataFulfilled event (interrupt; resumed externally)
  "cleared"/"rejected"/"error" → terminal (phase_gate will check)

The bridge injects "data_requested" state when DataFulfilled arrives on-chain.
"""

from __future__ import annotations

import logging

from langgraph.types import interrupt

from shared.bridge_base import call_mcp_tool
from graph.onboarding_state import OnboardingState

logger = logging.getLogger(__name__)

AML_MCP_ENDPOINT = "http://localhost:8010"


async def aml_node(state: OnboardingState) -> dict:
    flow_id    = state["flow_id"]
    status     = state.get("aml_status", "pending")
    request_id = state.get("aml_request_id") or ""
    trace_id   = state.get("trace_id", flow_id)

    logger.info("[aml-node] flow=%s status=%s", flow_id, status)

    if status == "pending":
        result = await call_mcp_tool(
            AML_MCP_ENDPOINT, "screen_client",
            {
                "flow_id":         flow_id,
                "request_id":      request_id,
                "client_agent_id": state.get("hf_doc_agent_id", "7"),
            },
            trace_id,
        )
        if result["action"] == "request_documents":
            logger.info("[aml-node] → requesting documents, spec=%s", result.get("spec_hash"))
            # Note: actual on-chain requestClientData is dispatched by aml_bridge
            return {
                "aml_status": "data_requested",
                "aml_data_round": state.get("aml_data_round", 0) + 1,
            }
        # submit_recommendation
        cleared = result.get("cleared", True)
        logger.info("[aml-node] → submitting recommendation, cleared=%s", cleared)
        return {
            "aml_status":    "cleared" if cleared else "rejected",
            "aml_result_hash": result.get("result_hash"),
        }

    if status == "data_requested":
        # Pause and wait for DataFulfilled event to be injected via update_state
        interrupt("aml: waiting for DataFulfilled event")
        # Graph resumes here when bridge calls ainvoke(Command(resume=...), config)
        return {}

    # Terminal states: cleared, rejected, error — nothing to do
    return {}
