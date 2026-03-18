"""
client_setup_server.py — MCP server for bank internal client setup agents.
Port of client-setup-server.js.

No prompt hash gate (client-setup.mcp.json has no prompts).
Implements setup_legal_entity, setup_account, setup_products.

Usage:
    python -m servers.client_setup_server [port]   # default 8014
"""

from __future__ import annotations

import logging
import sys

from web3 import Web3

from servers.server_base import create_server, suspended_when_revoked
from shared.bounds_monitor_client import report_tool_call

logger = logging.getLogger(__name__)


def _keccak(text: str) -> str:
    return Web3.keccak(text=text).hex()


mcp = create_server("client-setup-server")


@mcp.tool()
@suspended_when_revoked("setup_legal_entity")
async def setup_legal_entity(flow_id: str, trace_id: str = "") -> dict:
    """Register the client legal entity in bank internal systems."""
    logger.info("[setup-server] setup_legal_entity flow=%s", flow_id)
    report_tool_call("setup_legal_entity", success=True)
    return {
        "entity_spec_hash": _keccak(f"entity-spec:{flow_id}"),
        "entity_ref": f"ENT-{flow_id[:8].upper()}",
    }


@mcp.tool()
@suspended_when_revoked("setup_account")
async def setup_account(flow_id: str, trace_id: str = "") -> dict:
    """Provision trading accounts for the onboarded client."""
    logger.info("[setup-server] setup_account flow=%s", flow_id)
    report_tool_call("setup_account", success=True)
    return {
        "account_spec_hash": _keccak(f"account-spec:{flow_id}"),
        "account_ref": f"ACC-{flow_id[:8].upper()}",
    }


@mcp.tool()
@suspended_when_revoked("setup_products")
async def setup_products(flow_id: str, trace_id: str = "") -> dict:
    """Configure approved financial products for the client."""
    logger.info("[setup-server] setup_products flow=%s", flow_id)
    report_tool_call("setup_products", success=True)
    return {
        "product_spec_hash": _keccak(f"products-spec:{flow_id}"),
        "products": ["FX_SPOT", "IR_SWAP", "EQUITY_REPO"],
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8014
    logger.info("[client-setup-server] Starting on port %d", port)
    mcp.run(transport="streamable-http", host="0.0.0.0", port=port)
