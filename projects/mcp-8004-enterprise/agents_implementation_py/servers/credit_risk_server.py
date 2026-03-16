"""
credit_risk_server.py — MCP server for the bank credit risk assessment agent.
Port of credit-risk-server.js with LCEL chain.

Implements tools from agents/mcp/credit-risk.mcp.json.

Usage:
    python -m servers.credit_risk_server [port]   # default 8011
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Literal, Optional

from langchain_core.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from pydantic import BaseModel
from web3 import Web3

from servers.server_base import create_server, suspended_when_revoked
from shared.bounds_monitor_client import report_tool_call
from shared.prompt_hash import load_langchain_messages

logger = logging.getLogger(__name__)

# ── Load MCP spec & build LCEL chain ─────────────────────────────────────────

_SPEC_PATH = (
    Path(__file__).parent.parent.parent / "agents" / "mcp" / "credit-risk.mcp.json"
)
_spec = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
_lc_messages = load_langchain_messages(_spec)

_prompt = ChatPromptTemplate.from_messages(
    [(msg["role"], msg["content"]) for msg in _lc_messages]
)


class _CreditDecision(BaseModel):
    action: Literal[
        "request_documents", "propose_terms", "accept_terms", "submit_recommendation"
    ]
    approved: Optional[bool] = None
    reason: str = ""


_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
        ).with_structured_output(_CreditDecision)
        _chain = _prompt | llm
    return _chain


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


# ── Server ────────────────────────────────────────────────────────────────────

mcp = create_server("credit-risk-server")


@mcp.tool()
@suspended_when_revoked("assess_credit")
async def assess_credit(
    flow_id: str,
    request_id: str,
    client_agent_id: str,
    trace_id: str = "",
) -> dict:
    """Initiate credit risk assessment for a new onboarding client."""
    logger.info("[credit-server] [%s] assess_credit flow=%s", trace_id or "n/a", flow_id)

    decision: _CreditDecision = await _get_chain().ainvoke(
        {
            "client_name": f"Institutional Client #{client_agent_id}",
            "aum": os.getenv("DEFAULT_AUM", "N/A"),
        }
    )
    report_tool_call("assess_credit", success=True)

    if decision.action == "request_documents":
        return {
            "action": "request_documents",
            "spec_hash": _keccak(f"credit-doc-spec:{flow_id}:round1"),
        }
    if decision.action == "propose_terms":
        return {
            "action": "propose_terms",
            "terms_hash": _keccak(f"credit-terms:{flow_id}:round1"),
        }
    return {
        "action": "submit_recommendation",
        "result_hash": _keccak(f"credit-result:{flow_id}:initial"),
        "approved": decision.approved if decision.approved is not None else True,
    }


@mcp.tool()
@suspended_when_revoked("continue_assessment")
async def continue_assessment(
    flow_id: str,
    request_id: str,
    trigger: str,
    data_hash: str,
    current_round: int = 0,
    trace_id: str = "",
) -> dict:
    """Resume credit assessment after documents or a counter-proposal has been received."""
    logger.info(
        "[credit-server] [%s] continue_assessment flow=%s trigger=%s round=%s",
        trace_id or "n/a", flow_id, trigger, current_round,
    )

    decision: _CreditDecision = await _get_chain().ainvoke(
        {
            "client_name": f"Client (trigger={trigger}, round={current_round})",
            "aum": f"counter_hash={data_hash[:10]}..." if trigger == "counter_proposed" else "N/A",
        }
    )
    report_tool_call("continue_assessment", success=True)

    if decision.action == "request_documents":
        return {
            "action": "request_documents",
            "spec_hash": _keccak(f"credit-doc-spec:{flow_id}:round{current_round + 1}"),
        }
    if decision.action in ("propose_terms", "accept_terms"):
        round_n = current_round + 1
        terms = _keccak(f"credit-terms:{flow_id}:round{round_n}")
        return {
            "action": decision.action,
            "terms_hash": terms,
            "agreed_hash": terms if decision.action == "accept_terms" else None,
        }
    return {
        "action": "submit_recommendation",
        "result_hash": _keccak(f"credit-result:{flow_id}:round{current_round}"),
        "approved": decision.approved if decision.approved is not None else True,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8011
    logger.info("[credit-risk-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
