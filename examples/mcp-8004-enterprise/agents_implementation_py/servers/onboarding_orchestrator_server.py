"""
onboarding_orchestrator_server.py — MCP server for the bank onboarding orchestrator.
Port of onboarding-orchestrator-server.js.

The initiate_onboarding tool is the entry point for the LangGraph runner.
It does planning/logging and returns flow metadata; actual on-chain transactions
are dispatched by onboarding_orchestrator_bridge.py.

Usage:
    python -m servers.onboarding_orchestrator_server [port]   # default 8013
"""

from __future__ import annotations

import logging
import sys

from servers.server_base import create_server, suspended_when_revoked
from shared.bounds_monitor_client import report_tool_call

logger = logging.getLogger(__name__)

mcp = create_server("onboarding-orchestrator-server")


@mcp.tool()
@suspended_when_revoked("initiate_onboarding")
async def initiate_onboarding(
    flow_id: str,
    client_address: str,
    bank_aml_agent_id: str = "0",
    bank_credit_agent_id: str = "1",
    bank_legal_agent_id: str = "2",
    hf_doc_agent_id: str = "7",
    hf_credit_agent_id: str = "8",
    hf_legal_agent_id: str = "9",
    trace_id: str = "",
) -> dict:
    """
    Plan and log an onboarding flow initiation.
    Returns flow metadata; the bridge dispatches on-chain transactions.
    """
    logger.info(
        "[orchestrator-server] [%s] initiate_onboarding flow=%s client=%s",
        trace_id or "n/a", flow_id, client_address,
    )
    report_tool_call("initiate_onboarding", success=True)

    return {
        "flow_id": flow_id,
        "status": "planned",
        "aml_request_id": None,
        "credit_request_id": None,
        "legal_request_id": None,
        "agents": {
            "bank_aml":    bank_aml_agent_id,
            "bank_credit": bank_credit_agent_id,
            "bank_legal":  bank_legal_agent_id,
            "hf_doc":      hf_doc_agent_id,
            "hf_credit":   hf_credit_agent_id,
            "hf_legal":    hf_legal_agent_id,
        },
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8013
    logger.info("[onboarding-orchestrator-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
