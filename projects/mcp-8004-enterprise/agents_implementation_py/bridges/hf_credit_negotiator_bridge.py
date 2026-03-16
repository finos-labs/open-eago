"""
hf_credit_negotiator_bridge.py — Port of hf-credit-negotiator-bridge.js.

Watches CreditRiskOracle.TermsProposed events and submits counter-proposals
via the HF credit negotiator MCP server.

Usage:
    python -m bridges.hf_credit_negotiator_bridge \
        --credit-contract 0x... --rpc http://... --privkey 0x... --agent-id 8
ENV: CREDIT_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, HF_CREDIT_AGENT_ID
"""

from __future__ import annotations

import asyncio
import logging
import sys

from shared.abis import CREDIT_ORACLE_ABI
from shared.bridge_base import arg, build_web3, call_mcp_tool
from shared.vault_signer import create_signer

logger = logging.getLogger(__name__)

LABEL        = "hf-credit-bridge"
MCP_ENDPOINT = arg("--mcp-endpoint", "HF_CREDIT_MCP_ENDPOINT", "http://localhost:8021")

RPC_URL       = arg("--rpc",          "RPC_URL",             "http://127.0.0.1:8545")
PRIVATE_KEY   = arg("--privkey",      "ORACLE_PRIVATE_KEY")
SIGNER_TYPE   = arg("--signer-type",  "SIGNER_TYPE",         "local")
VAULT_URL     = arg("--vault-url",    "VAULT_URL")
VAULT_ADDRESS = arg("--vault-address","ORACLE_ADDRESS")
AGENT_ID      = int(arg("--agent-id", "HF_CREDIT_AGENT_ID", "8"))

CREDIT_CONTRACT = arg("--credit-contract", "CREDIT_CONTRACT_ADDRESS")


def _hex(b) -> str:
    return b.hex() if isinstance(b, bytes) else str(b).removeprefix("0x")


def _bytes(h: str) -> bytes:
    return bytes.fromhex(h.removeprefix("0x"))


async def _handle_terms_proposed(oracle, event) -> None:
    args      = event["args"]
    request_id = args["requestId"]
    flow_id    = args["flowId"]
    terms_hash = args["termsHash"]
    round_num  = args["round"]
    flow_hex   = _hex(flow_id)

    logger.info("\n[%s] ← TermsProposed  requestId=%s  round=%d", LABEL, _hex(request_id), round_num)

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT, "evaluate_terms",
            {
                "flow_id":    flow_hex,
                "request_id": _hex(request_id),
                "terms_hash": _hex(terms_hash),
                "round":      int(round_num),
            },
            flow_hex,
        )

        logger.info(
            "[%s]   → submitCounterProposal  accepting=%s  hash=%s",
            LABEL, result["accepting"], result["proposal_hash"],
        )
        req_bytes = request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id))
        tx = await oracle.functions.submitCounterProposal(
            req_bytes, AGENT_ID, _bytes(result["proposal_hash"])
        ).transact()
        logger.info("[%s]   ✓ submitCounterProposal  tx=%s", LABEL, tx.hex())
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def main() -> None:
    if not CREDIT_CONTRACT:
        logger.error("[%s] Missing --credit-contract", LABEL); sys.exit(1)
    if SIGNER_TYPE == "local" and not PRIVATE_KEY:
        logger.error("[%s] Missing --privkey",         LABEL); sys.exit(1)

    signer = create_signer(SIGNER_TYPE, PRIVATE_KEY, VAULT_URL, VAULT_ADDRESS)
    w3, _  = build_web3(RPC_URL, signer)
    oracle = w3.eth.contract(address=CREDIT_CONTRACT, abi=CREDIT_ORACLE_ABI)

    logger.info("[%s] Signer        : %s", LABEL, signer.address)
    logger.info("[%s] CreditOracle  : %s", LABEL, CREDIT_CONTRACT)
    logger.info("[%s] AgentId       : %d", LABEL, AGENT_ID)
    logger.info("[%s] MCP endpoint  : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] Listening for TermsProposed events…", LABEL)

    terms_filter = await oracle.events.TermsProposed.create_filter(from_block="latest")

    while True:
        for event in await terms_filter.get_new_entries():
            asyncio.create_task(_handle_terms_proposed(oracle, event))
        await asyncio.sleep(2)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
