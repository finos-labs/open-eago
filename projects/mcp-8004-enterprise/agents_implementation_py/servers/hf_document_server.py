"""
hf_document_server.py — MCP server for the hedge fund document agent.
Port of hf-document-server.js with LCEL chain.

Implements tools from agents/mcp/hf-document.mcp.json.

Usage:
    python -m servers.hf_document_server [port]   # default 8020
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
    Path(__file__).parent.parent.parent / "agents" / "mcp" / "hf-document.mcp.json"
)
_spec = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
_lc_messages = load_langchain_messages(_spec)

_prompt = ChatPromptTemplate.from_messages(
    [(msg["role"], msg["content"]) for msg in _lc_messages]
)


class _DocDecision(BaseModel):
    documents: list[str] = ["corporate_structure", "beneficial_ownership", "financials", "source_of_funds"]
    notes: str = ""


_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
        ).with_structured_output(_DocDecision)
        _chain = _prompt | llm
    return _chain


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


mcp = create_server("hf-document-server")


@mcp.tool()
@suspended_when_revoked("assemble_documents")
async def assemble_documents(
    flow_id: str,
    request_id: str,
    oracle_type: str,
    spec_hash: str,
    round: int = 1,
    trace_id: str = "",
) -> dict:
    """Assemble client documents in response to a bank data request."""
    logger.info(
        "[hf-doc-server] [%s] assemble_documents flow=%s oracle=%s round=%s",
        trace_id or "n/a", flow_id, oracle_type, round,
    )

    decision: _DocDecision = await _get_chain().ainvoke(
        {"oracle_type": oracle_type, "flow_id": flow_id}
    )
    report_tool_call("assemble_documents", success=True)

    data_hash = _keccak(f"hf-docs:{flow_id}:{oracle_type}:round{round}")
    return {
        "data_hash": data_hash,
        "documents": decision.documents,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8020
    logger.info("[hf-document-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
