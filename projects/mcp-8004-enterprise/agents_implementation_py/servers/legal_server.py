"""
legal_server.py — MCP server for the bank legal document review agent.
Port of legal-server.js with LCEL chain.

Implements tools from agents/mcp/legal-review.mcp.json.

Usage:
    python -m servers.legal_server [port]   # default 8012
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
    Path(__file__).parent.parent.parent / "agents" / "mcp" / "legal-review.mcp.json"
)
_spec = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
_lc_messages = load_langchain_messages(_spec)

_prompt = ChatPromptTemplate.from_messages(
    [(msg["role"], msg["content"]) for msg in _lc_messages]
)


class _LegalDecision(BaseModel):
    action: Literal["issue_revised_draft", "submit_recommendation"]
    reason: str = ""


_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
        ).with_structured_output(_LegalDecision)
        _chain = _prompt | llm
    return _chain


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


# ── Server ────────────────────────────────────────────────────────────────────

mcp = create_server("legal-server")


@mcp.tool()
@suspended_when_revoked("issue_initial_draft")
async def issue_initial_draft(
    flow_id: str,
    request_id: str,
    client_agent_id: str,
    trace_id: str = "",
) -> dict:
    """Produce the initial contract draft for the client's onboarding."""
    logger.info("[legal-server] [%s] issue_initial_draft flow=%s", trace_id or "n/a", flow_id)

    # Draft generation uses the prompt; decision is always "issue draft" here
    await _get_chain().ainvoke(
        {
            "client_name": f"Institutional Client #{client_agent_id}",
            "jurisdiction": os.getenv("DEFAULT_JURISDICTION", "England and Wales"),
            "credit_limit": os.getenv("DEFAULT_CREDIT_LIMIT", "TBD"),
        }
    )
    report_tool_call("issue_initial_draft", success=True)

    draft_hash = _keccak(f"legal-draft:{flow_id}:round1")
    return {"draft_hash": draft_hash, "round": 1}


@mcp.tool()
@suspended_when_revoked("review_markup_and_respond")
async def review_markup_and_respond(
    flow_id: str,
    request_id: str,
    markup_hash: str,
    round: int,
    trace_id: str = "",
) -> dict:
    """Review the client's markup and decide: issue revised draft or submit recommendation."""
    logger.info(
        "[legal-server] [%s] review_markup_and_respond flow=%s round=%s",
        trace_id or "n/a", flow_id, round,
    )

    decision: _LegalDecision = await _get_chain().ainvoke(
        {
            "client_name": f"Client (markup review, round={round})",
            "jurisdiction": os.getenv("DEFAULT_JURISDICTION", "England and Wales"),
            "credit_limit": "As agreed in credit review",
        }
    )
    report_tool_call("review_markup_and_respond", success=True)

    if decision.action == "issue_revised_draft":
        return {
            "action": "issue_revised_draft",
            "draft_hash": _keccak(f"legal-draft:{flow_id}:round{round + 1}"),
        }
    return {
        "action": "submit_recommendation",
        "final_hash": _keccak(f"legal-final:{flow_id}:round{round}"),
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8012
    logger.info("[legal-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
