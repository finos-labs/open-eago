"""
hf_document_bridge.py — Port of hf-document-bridge.js using web3.py AsyncWeb3.

Watches DataRequested events from both AMLOracle and CreditRiskOracle,
calls the HF document MCP server, and submits fulfillDataRequest().

Usage:
    python -m bridges.hf_document_bridge \
        --aml-contract 0x... --credit-contract 0x... \
        --rpc http://... --privkey 0x... --agent-id 7
ENV: AML_CONTRACT_ADDRESS, CREDIT_CONTRACT_ADDRESS, RPC_URL,
     ORACLE_PRIVATE_KEY, HF_DOC_AGENT_ID
"""

from __future__ import annotations

import asyncio
import logging
import sys

from shared.abis import AML_ORACLE_ABI, CREDIT_ORACLE_ABI
from shared.bridge_base import arg, build_web3, call_mcp_tool
from shared.vault_signer import create_signer

logger = logging.getLogger(__name__)

LABEL        = "hf-document-bridge"
MCP_ENDPOINT = arg("--mcp-endpoint", "HF_DOC_MCP_ENDPOINT", "http://localhost:8020")

RPC_URL       = arg("--rpc",          "RPC_URL",             "http://127.0.0.1:8545")
PRIVATE_KEY   = arg("--privkey",      "ORACLE_PRIVATE_KEY")
SIGNER_TYPE   = arg("--signer-type",  "SIGNER_TYPE",         "local")
VAULT_URL     = arg("--vault-url",    "VAULT_URL")
VAULT_ADDRESS = arg("--vault-address","ORACLE_ADDRESS")
AGENT_ID      = int(arg("--agent-id", "HF_DOC_AGENT_ID", "7"))

AML_CONTRACT    = arg("--aml-contract",    "AML_CONTRACT_ADDRESS")
CREDIT_CONTRACT = arg("--credit-contract", "CREDIT_CONTRACT_ADDRESS")


def _hex(b) -> str:
    return b.hex() if isinstance(b, bytes) else str(b).removeprefix("0x")


def _bytes(h: str) -> bytes:
    return bytes.fromhex(h.removeprefix("0x"))


async def _handle_data_requested(oracle, oracle_type: str, event) -> None:
    args = event["args"]
    request_id   = args["requestId"]
    flow_id      = args["flowId"]
    data_spec    = args["dataSpecHash"]
    round_num    = args["round"]
    flow_hex     = _hex(flow_id)

    logger.info(
        "\n[%s] ← DataRequested [%s]  requestId=%s  round=%d",
        LABEL, oracle_type, _hex(request_id), round_num,
    )

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT, "assemble_documents",
            {
                "flow_id":    flow_hex,
                "request_id": _hex(request_id),
                "oracle_type": oracle_type,
                "spec_hash":   _hex(data_spec),
                "round":       int(round_num),
            },
            flow_hex,
        )

        logger.info(
            "[%s]   → fulfillDataRequest  dataHash=%s  docs=%s",
            LABEL, result["data_hash"], ",".join(result.get("documents", [])),
        )
        req_bytes = request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id))
        tx = await oracle.functions.fulfillDataRequest(
            req_bytes, AGENT_ID, _bytes(result["data_hash"])
        ).transact()
        logger.info("[%s]   ✓ fulfillDataRequest  tx=%s", LABEL, tx.hex())
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def main() -> None:
    if not AML_CONTRACT:
        logger.error("[%s] Missing --aml-contract",    LABEL); sys.exit(1)
    if not CREDIT_CONTRACT:
        logger.error("[%s] Missing --credit-contract", LABEL); sys.exit(1)
    if SIGNER_TYPE == "local" and not PRIVATE_KEY:
        logger.error("[%s] Missing --privkey",         LABEL); sys.exit(1)

    signer = create_signer(SIGNER_TYPE, PRIVATE_KEY, VAULT_URL, VAULT_ADDRESS)
    w3, _  = build_web3(RPC_URL, signer)

    aml_oracle    = w3.eth.contract(address=AML_CONTRACT,    abi=AML_ORACLE_ABI)
    credit_oracle = w3.eth.contract(address=CREDIT_CONTRACT, abi=CREDIT_ORACLE_ABI)

    logger.info("[%s] Signer       : %s", LABEL, signer.address)
    logger.info("[%s] AMLOracle    : %s", LABEL, AML_CONTRACT)
    logger.info("[%s] CreditOracle : %s", LABEL, CREDIT_CONTRACT)
    logger.info("[%s] AgentId      : %d", LABEL, AGENT_ID)
    logger.info("[%s] MCP endpoint : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] Listening for DataRequested events…", LABEL)

    aml_filter    = await aml_oracle.events.DataRequested.create_filter(from_block="latest")
    credit_filter = await credit_oracle.events.DataRequested.create_filter(from_block="latest")

    while True:
        for event in await aml_filter.get_new_entries():
            asyncio.create_task(_handle_data_requested(aml_oracle, "aml", event))
        for event in await credit_filter.get_new_entries():
            asyncio.create_task(_handle_data_requested(credit_oracle, "credit", event))
        await asyncio.sleep(2)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
