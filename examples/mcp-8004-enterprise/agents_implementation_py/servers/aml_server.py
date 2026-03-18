"""
aml_server.py — MCP server for the bank AML screening agent.
Port of aml-server.js with LCEL chain replacing the stub.

Implements tools from agents/mcp/aml-review.mcp.json.
Prompt template loaded from langchain_messages field (version 1 canonical format).

Usage:
    python -m servers.aml_server [port]          # default 8010
    python -m servers.aml_server 8110            # smoke-test port
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
    Path(__file__).parent.parent.parent / "agents" / "mcp" / "aml-review.mcp.json"
)
_spec = json.loads(_SPEC_PATH.read_text(encoding="utf-8"))
_lc_messages = load_langchain_messages(_spec)

_prompt = ChatPromptTemplate.from_messages(
    [(msg["role"], msg["content"]) for msg in _lc_messages]
)


class _AMLDecision(BaseModel):
    """LLM decision model — action + reason; hashes computed in handler."""
    action: Literal["request_documents", "submit_recommendation"]
    cleared: Optional[bool] = None
    reason: str = ""


_chain = None


def _get_chain():
    global _chain
    if _chain is None:
        llm = ChatOpenAI(
            model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            temperature=0,
        ).with_structured_output(_AMLDecision)
        _chain = _prompt | llm
    return _chain


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


# ── Server ────────────────────────────────────────────────────────────────────

mcp = create_server("aml-server")


@mcp.tool()
@suspended_when_revoked("screen_client")
async def screen_client(
    flow_id: str,
    request_id: str,
    client_agent_id: str,
    trace_id: str = "",
) -> dict:
    """Initiate AML screening for a new onboarding client."""
    logger.info("[aml-server] [%s] screen_client flow=%s", trace_id or "n/a", flow_id)

    decision: _AMLDecision = await _get_chain().ainvoke(
        {
            "client_name": f"Institutional Client #{client_agent_id}",
            "jurisdiction": os.getenv("DEFAULT_JURISDICTION", "Cayman Islands"),
        }
    )
    report_tool_call("screen_client", success=True)

    if decision.action == "request_documents":
        return {
            "action": "request_documents",
            "spec_hash": _keccak(f"aml-doc-spec:{flow_id}:round1"),
        }
    return {
        "action": "submit_recommendation",
        "result_hash": _keccak(f"aml-result:{flow_id}:initial"),
        "cleared": decision.cleared if decision.cleared is not None else True,
    }


@mcp.tool()
@suspended_when_revoked("continue_screening")
async def continue_screening(
    flow_id: str,
    request_id: str,
    data_hash: str,
    round: int = 1,
    trace_id: str = "",
) -> dict:
    """Resume AML screening after client documents have been submitted."""
    logger.info(
        "[aml-server] [%s] continue_screening flow=%s round=%s data=%s",
        trace_id or "n/a", flow_id, round, data_hash,
    )

    decision: _AMLDecision = await _get_chain().ainvoke(
        {
            "client_name": f"Institutional Client (data round {round})",
            "jurisdiction": os.getenv("DEFAULT_JURISDICTION", "Cayman Islands"),
        }
    )
    report_tool_call("continue_screening", success=True)

    if decision.action == "request_documents":
        return {
            "action": "request_documents",
            "spec_hash": _keccak(f"aml-doc-spec:{flow_id}:round{round + 1}"),
        }
    return {
        "action": "submit_recommendation",
        "result_hash": _keccak(f"aml-result:{flow_id}:round{round}"),
        "cleared": decision.cleared if decision.cleared is not None else True,
    }


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8010
    logger.info("[aml-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
