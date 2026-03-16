"""
hf_credit_negotiator_server.py — MCP server for the hedge fund credit negotiation agent.
Port of hf-credit-negotiator-server.js with LCEL chain.

Implements tools from agents/mcp/hf-credit-negotiator.mcp.json.

Usage:
    python -m servers.hf_credit_negotiator_server [port]   # default 8021
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

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
    Path(__file__).parent.parent.parent
    / "agents"
    / "mcp"
    / "hf-credit-negotiator.mcp.json"
)
_spec = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
_lc_messages = load_langchain_messages(_spec)

_prompt = ChatPromptTemplate.from_messages(
    [(msg["role"], msg["content"]) for msg in _lc_messages]
)


class _NegotiationDecision(BaseModel):
    accepting: bool = False
    notes: str = ""


_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
        ).with_structured_output(_NegotiationDecision)
        _chain = _prompt | llm
    return _chain


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


mcp = create_server("hf-credit-negotiator-server")


@mcp.tool()
@suspended_when_revoked("evaluate_terms")
async def evaluate_terms(
    flow_id: str,
    request_id: str,
    terms_hash: str,
    round: int,
    trace_id: str = "",
) -> dict:
    """Evaluate bank-proposed credit terms. Returns counter-proposal hash or signals acceptance."""
    logger.info(
        "[hf-credit-server] [%s] evaluate_terms flow=%s round=%s",
        trace_id or "n/a", flow_id, round,
    )

    decision: _NegotiationDecision = await _get_chain().ainvoke(
        {"terms_hash": terms_hash, "round": str(round)}
    )
    report_tool_call("evaluate_terms", success=True)

    if decision.accepting:
        # Accept: counter-proposal hash = original terms hash (signal acceptance)
        return {
            "proposal_hash": terms_hash,
            "accepting": True,
            "notes": decision.notes or "Accepting proposed terms.",
        }

    # Counter-propose with a new hash
    proposal_hash = _keccak(f"hf-counter:{flow_id}:round{round}")
    return {
        "proposal_hash": proposal_hash,
        "accepting": False,
        "notes": decision.notes or "Submitting counter-proposal.",
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8021
    logger.info("[hf-credit-negotiator-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
