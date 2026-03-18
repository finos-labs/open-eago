"""
legal_bridge.py — Port of legal-bridge.js using web3.py AsyncWeb3.

Watches LegalOracle events and routes to/from the Python legal MCP server.

Event flows:
  LegalReviewRequested → issue_initial_draft → issueDraft()
  MarkupSubmitted      → review_markup_and_respond
    → issue_revised_draft → issueDraft()
    → submit_recommendation → submitRecommendation()

Usage:
    python -m bridges.legal_bridge \
        --contract 0x... --rpc http://... --privkey 0x... --agent-id 2
ENV: LEGAL_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, LEGAL_AGENT_ID
"""

from __future__ import annotations

import asyncio
import logging

from web3 import Web3

from shared.abis import LEGAL_ORACLE_ABI
from shared.bridge_base import arg, bootstrap_bridge, call_mcp_tool, governance_preflight

logger = logging.getLogger(__name__)

LABEL        = "legal-bridge"
MCP_ENDPOINT = arg("--mcp-endpoint", "LEGAL_MCP_ENDPOINT", "http://localhost:8012")

CAP_LEGAL  = Web3.keccak(text="legal_review")
TOOL_DRAFT = Web3.keccak(text="issue_initial_draft")


def _hex(b) -> str:
    return b.hex() if isinstance(b, bytes) else str(b).removeprefix("0x")


def _bytes(h: str) -> bytes:
    return bytes.fromhex(h.removeprefix("0x"))


async def main() -> None:
    ctx = await bootstrap_bridge(
        LABEL,
        contract_flag="--contract",
        contract_env="LEGAL_CONTRACT_ADDRESS",
        agent_id_env="LEGAL_AGENT_ID",
        card_glob="bank-legal-agent.json",
    )

    oracle = ctx.w3.eth.contract(address=ctx.contract_address, abi=LEGAL_ORACLE_ABI)
    logger.info("[%s] MCP endpoint : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] Listening for LegalOracle events…", LABEL)

    review_filter = await oracle.events.LegalReviewRequested.create_filter(from_block="latest")
    markup_filter = await oracle.events.MarkupSubmitted.create_filter(from_block="latest")
    human_filter  = await oracle.events.InHumanReview.create_filter(from_block="latest")

    while True:
        for event in await review_filter.get_new_entries():
            asyncio.create_task(_handle_review_requested(oracle, ctx, event))
        for event in await markup_filter.get_new_entries():
            asyncio.create_task(_handle_markup_submitted(oracle, ctx, event))
        for event in await human_filter.get_new_entries():
            _handle_in_human_review(event)
        await asyncio.sleep(2)


async def _handle_review_requested(oracle, ctx, event) -> None:
    args = event["args"]
    request_id, flow_id = args["requestId"], args["flowId"]
    client_agent_id     = args["clientAgentId"]
    trace_id = _hex(flow_id)

    logger.info("\n[%s] ← LegalReviewRequested  requestId=%s  flowId=%s", LABEL, _hex(request_id), trace_id)

    if not await governance_preflight(
        LABEL, flow_id=flow_id, agent_id=ctx.agent_id,
        capability=CAP_LEGAL, tool_hash=TOOL_DRAFT, contracts=ctx.contracts,
    ):
        return

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT, "issue_initial_draft",
            {"flow_id": trace_id, "request_id": _hex(request_id), "client_agent_id": str(client_agent_id)},
            trace_id,
        )
        logger.info("[%s]   → issueDraft  round=%s  hash=%s", LABEL, result["round"], result["draft_hash"])
        req_bytes = request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id))
        tx = await oracle.functions.issueDraft(req_bytes, ctx.agent_id, _bytes(result["draft_hash"])).transact()
        logger.info("[%s]   ✓ issueDraft  tx=%s", LABEL, tx.hex())
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def _handle_markup_submitted(oracle, ctx, event) -> None:
    args = event["args"]
    request_id, flow_id = args["requestId"], args["flowId"]
    markup_hash = args["markupHash"]
    round_num   = args["round"]
    trace_id    = _hex(flow_id)

    logger.info("\n[%s] ← MarkupSubmitted  requestId=%s  round=%s", LABEL, _hex(request_id), round_num)

    if not await governance_preflight(
        LABEL, flow_id=flow_id, agent_id=ctx.agent_id,
        capability=CAP_LEGAL, tool_hash=TOOL_DRAFT, contracts=ctx.contracts,
    ):
        return

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT, "review_markup_and_respond",
            {
                "flow_id": trace_id, "request_id": _hex(request_id),
                "markup_hash": _hex(markup_hash), "round": int(round_num),
            },
            trace_id,
        )
        req_bytes = request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id))
        if result["action"] == "issue_revised_draft":
            logger.info("[%s]   → issueDraft (revised)  hash=%s", LABEL, result["draft_hash"])
            tx = await oracle.functions.issueDraft(req_bytes, ctx.agent_id, _bytes(result["draft_hash"])).transact()
            logger.info("[%s]   ✓ issueDraft  tx=%s", LABEL, tx.hex())
        else:
            logger.info("[%s]   → submitRecommendation  final=%s", LABEL, result["final_hash"])
            tx = await oracle.functions.submitRecommendation(req_bytes, ctx.agent_id, _bytes(result["final_hash"])).transact()
            logger.info("[%s]   ✓ submitRecommendation  tx=%s", LABEL, tx.hex())
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


def _handle_in_human_review(event) -> None:
    args = event["args"]
    logger.info(
        "\n[%s] *** InHumanReview  requestId=%s  round=%s",
        LABEL, _hex(args["requestId"]), args["round"],
    )
    logger.info("[%s] *** Human approvers: call approveBankSide() + approveClientSide() then execute()", LABEL)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
