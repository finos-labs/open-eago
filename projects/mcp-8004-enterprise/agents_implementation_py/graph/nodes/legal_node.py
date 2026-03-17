"""
legal_node.py — LangGraph node: LEGAL_NODE

Handles all legal review statuses with the markup loop:
  "pending"         → issue_initial_draft → stores draft_hash, moves to draft_issued
  "draft_issued"    → interrupt (wait for MarkupSubmitted from HF legal agent)
  "markup_received" → review_markup_and_respond → issue_revised_draft or submit_recommendation
  "human_review"    → interrupt (wait for human approvers approveBankSide + approveClientSide)
  "approved"/"rejected"/"error" → terminal
"""

from __future__ import annotations

import logging

from langgraph.types import interrupt

from shared.bridge_base import call_mcp_tool
from graph.onboarding_state import OnboardingState

logger = logging.getLogger(__name__)

LEGAL_MCP_ENDPOINT = "http://localhost:8012"


async def legal_node(state: OnboardingState) -> dict:
    flow_id    = state["flow_id"]
    status     = state.get("legal_status", "pending")
    request_id = state.get("legal_request_id") or ""
    trace_id   = state.get("trace_id", flow_id)
    round_n    = state.get("legal_markup_round", 0)

    logger.info("[legal-node] flow=%s status=%s round=%d", flow_id, status, round_n)

    if status == "pending":
        result = await call_mcp_tool(
            LEGAL_MCP_ENDPOINT, "issue_initial_draft",
            {
                "flow_id":         flow_id,
                "request_id":      request_id,
                "client_agent_id": state.get("hf_legal_agent_id", "9"),
            },
            trace_id,
        )
        logger.info("[legal-node] → initial draft issued, hash=%s round=%s", result["draft_hash"], result["round"])
        return {
            "legal_status":    "draft_issued",
            "legal_draft_hash": result["draft_hash"],
            "legal_markup_round": 1,
        }

    if status == "draft_issued":
        # Pause: wait for MarkupSubmitted event from HF legal agent
        interrupt("legal: waiting for MarkupSubmitted event")
        return {}

    if status == "markup_received":
        markup_hash = state.get("legal_draft_hash") or ""
        result = await call_mcp_tool(
            LEGAL_MCP_ENDPOINT, "review_markup_and_respond",
            {
                "flow_id":     flow_id,
                "request_id":  request_id,
                "markup_hash": markup_hash,
                "round":       round_n,
            },
            trace_id,
        )
        if result["action"] == "issue_revised_draft":
            logger.info("[legal-node] → revised draft, hash=%s", result["draft_hash"])
            return {
                "legal_status":    "draft_issued",
                "legal_draft_hash": result["draft_hash"],
                "legal_markup_round": round_n + 1,
            }
        logger.info("[legal-node] → submitting recommendation, final=%s", result.get("final_hash"))
        return {
            "legal_status":    "human_review",  # moves to InHumanReview on-chain
            "legal_draft_hash": result.get("final_hash"),
        }

    if status == "human_review":
        # Pause: wait for human approvals (approveBankSide + approveClientSide + execute)
        interrupt("legal: waiting for human approval")
        return {}

    if status == "approved":
        return {}

    # rejected / error
    return {}
