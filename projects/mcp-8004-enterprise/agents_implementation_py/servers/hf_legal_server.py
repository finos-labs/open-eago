"""
hf_legal_server.py — MCP server for the hedge fund legal review agent.
Port of hf-legal-server.js with LCEL chain.

Implements tools from agents/mcp/hf-legal.mcp.json.

Usage:
    python -m servers.hf_legal_server [port]   # default 8022
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
    Path(__file__).parent.parent.parent / "agents" / "mcp" / "hf-legal.mcp.json"
)
_spec = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
_lc_messages = load_langchain_messages(_spec)

_prompt = ChatPromptTemplate.from_messages(
    [(msg["role"], msg["content"]) for msg in _lc_messages]
)


class _LegalMarkupDecision(BaseModel):
    changes: int = 3
    notes: str = ""


_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
        ).with_structured_output(_LegalMarkupDecision)
        _chain = _prompt | llm
    return _chain


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


mcp = create_server("hf-legal-server")


@mcp.tool()
@suspended_when_revoked("review_draft")
async def review_draft(
    flow_id: str,
    request_id: str,
    draft_hash: str,
    round: int,
    trace_id: str = "",
) -> dict:
    """Review a contract draft issued by the bank's legal agent. Returns markup hash."""
    logger.info(
        "[hf-legal-server] [%s] review_draft flow=%s round=%s",
        trace_id or "n/a", flow_id, round,
    )

    decision: _LegalMarkupDecision = await _get_chain().ainvoke(
        {"draft_hash": draft_hash, "round": str(round)}
    )
    report_tool_call("review_draft", success=True)

    markup_hash = _keccak(f"hf-markup:{flow_id}:round{round}")
    return {
        "markup_hash": markup_hash,
        "changes": decision.changes,
        "notes": decision.notes or f"Markup submitted for round {round}.",
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8022
    logger.info("[hf-legal-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
