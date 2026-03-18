"""
aml_bridge.py — Port of aml-bridge.js using web3.py AsyncWeb3.

Watches AMLOracle events and routes to/from the Python AML MCP server.

Event flows:
  AMLReviewRequested → screen_client
    → request_documents → requestClientData()
    → submit_recommendation → submitRecommendation()
  DataFulfilled → continue_screening
    → same actions

Usage:
    python -m bridges.aml_bridge \
        --contract 0x... --rpc http://... --privkey 0x... --agent-id 0
ENV: AML_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, AML_AGENT_ID
"""

from __future__ import annotations

import asyncio
import logging
import os

from web3 import Web3

from shared.abis import AML_ORACLE_ABI
from shared.bridge_base import arg, bootstrap_bridge, call_mcp_tool, governance_preflight

logger = logging.getLogger(__name__)

LABEL        = "aml-bridge"
MCP_ENDPOINT = arg("--mcp-endpoint", "AML_MCP_ENDPOINT", "http://localhost:8010")

CAP_AML_REVIEW = Web3.keccak(text="aml_review")
TOOL_SCREEN    = Web3.keccak(text="screen_client")


async def _handle_review_requested(oracle, agent_id: int, contracts: dict, event) -> None:
    args = event["args"]
    request_id    = args["requestId"]
    flow_id       = args["flowId"]
    client_agent_id = args["clientAgentId"]
    trace_id      = flow_id.hex() if isinstance(flow_id, bytes) else flow_id

    logger.info("\n[%s] ← AMLReviewRequested  requestId=%s  flowId=%s", LABEL, request_id.hex(), trace_id)

    ok = await governance_preflight(
        LABEL,
        flow_id=flow_id if isinstance(flow_id, bytes) else bytes.fromhex(flow_id.removeprefix("0x")),
        agent_id=agent_id,
        capability=CAP_AML_REVIEW,
        tool_hash=TOOL_SCREEN,
        contracts=contracts,
    )
    if not ok:
        return

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT,
            "screen_client",
            {
                "flow_id":         trace_id,
                "request_id":      request_id.hex(),
                "client_agent_id": str(client_agent_id),
            },
            trace_id,
        )

        req_id_bytes = request_id if isinstance(request_id, bytes) else bytes.fromhex(request_id.removeprefix("0x"))
        if result["action"] == "request_documents":
            logger.info("[%s]   → requestClientData  spec=%s", LABEL, result["spec_hash"])
            spec = bytes.fromhex(result["spec_hash"].removeprefix("0x"))
            tx_hash = await oracle.functions.requestClientData(req_id_bytes, agent_id, spec).transact()
            logger.info("[%s]   ✓ requestClientData  tx=%s", LABEL, tx_hash.hex())
        else:
            logger.info("[%s]   → submitRecommendation  cleared=%s", LABEL, result.get("cleared"))
            res_hash = bytes.fromhex(result["result_hash"].removeprefix("0x"))
            tx_hash = await oracle.functions.submitRecommendation(req_id_bytes, agent_id, res_hash).transact()
            logger.info("[%s]   ✓ submitRecommendation  tx=%s", LABEL, tx_hash.hex())
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def _handle_data_fulfilled(oracle, agent_id: int, contracts: dict, event) -> None:
    args = event["args"]
    request_id       = args["requestId"]
    flow_id          = args["flowId"]
    data_hash        = args["dataHash"]
    submitting_agent = args["submittingAgentId"]
    trace_id         = flow_id.hex() if isinstance(flow_id, bytes) else flow_id

    if submitting_agent == agent_id:
        return  # our own fulfillment

    logger.info("\n[%s] ← DataFulfilled  requestId=%s  dataHash=%s", LABEL, request_id.hex(), data_hash.hex())

    ok = await governance_preflight(
        LABEL,
        flow_id=flow_id if isinstance(flow_id, bytes) else bytes.fromhex(flow_id.removeprefix("0x")),
        agent_id=agent_id,
        capability=CAP_AML_REVIEW,
        tool_hash=TOOL_SCREEN,
        contracts=contracts,
    )
    if not ok:
        return

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT,
            "continue_screening",
            {
                "flow_id":    trace_id,
                "request_id": request_id.hex(),
                "data_hash":  data_hash.hex(),
                "round":      1,
            },
            trace_id,
        )

        req_id_bytes = request_id if isinstance(request_id, bytes) else bytes.fromhex(request_id.removeprefix("0x"))
        if result["action"] == "request_documents":
            spec = bytes.fromhex(result["spec_hash"].removeprefix("0x"))
            tx_hash = await oracle.functions.requestClientData(req_id_bytes, agent_id, spec).transact()
            logger.info("[%s]   ✓ requestClientData (round 2)  tx=%s", LABEL, tx_hash.hex())
        else:
            res_hash = bytes.fromhex(result["result_hash"].removeprefix("0x"))
            tx_hash = await oracle.functions.submitRecommendation(req_id_bytes, agent_id, res_hash).transact()
            logger.info("[%s]   ✓ submitRecommendation  tx=%s", LABEL, tx_hash.hex())
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def main() -> None:
    ctx = await bootstrap_bridge(
        LABEL,
        contract_flag="--contract",
        contract_env="AML_CONTRACT_ADDRESS",
        agent_id_env="AML_AGENT_ID",
        card_glob="bank-aml-agent.json",
        prompt_name="bank-aml-agent",
        prompt_version_env="AML_PROMPT_VERSION",
    )

    oracle = ctx.w3.eth.contract(address=ctx.contract_address, abi=AML_ORACLE_ABI)

    logger.info("[%s] MCP endpoint : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] Listening for AMLOracle events…", LABEL)

    # Poll for events (web3.py async event polling)
    review_filter = await oracle.events.AMLReviewRequested.create_filter(from_block="latest")
    data_filter   = await oracle.events.DataFulfilled.create_filter(from_block="latest")

    while True:
        for event in await review_filter.get_new_entries():
            asyncio.create_task(
                _handle_review_requested(oracle, ctx.agent_id, ctx.contracts, event)
            )
        for event in await data_filter.get_new_entries():
            asyncio.create_task(
                _handle_data_fulfilled(oracle, ctx.agent_id, ctx.contracts, event)
            )
        await asyncio.sleep(2)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
