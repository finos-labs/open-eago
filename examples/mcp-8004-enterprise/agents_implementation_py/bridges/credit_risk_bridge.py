"""
credit_risk_bridge.py — Port of credit-risk-bridge.js using web3.py AsyncWeb3.

Watches CreditRiskOracle events and routes to/from the Python credit risk MCP server.

Event flows:
  CreditReviewRequested → assess_credit
    → request_documents → requestClientData()
    → propose_terms     → proposeTerms()
    → submit_recommendation → submitRecommendation()
  DataFulfilled   → continue_assessment(trigger='data_fulfilled')
  CounterProposed → continue_assessment(trigger='counter_proposed')
    → propose_terms  → proposeTerms() (new round)
    → accept_terms   → acceptTerms() then submitRecommendation()

Usage:
    python -m bridges.credit_risk_bridge \
        --contract 0x... --rpc http://... --privkey 0x... --agent-id 1
ENV: CREDIT_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, CREDIT_AGENT_ID
"""

from __future__ import annotations

import asyncio
import logging

from web3 import Web3

from shared.abis import CREDIT_ORACLE_ABI
from shared.bridge_base import arg, bootstrap_bridge, call_mcp_tool, governance_preflight

logger = logging.getLogger(__name__)

LABEL        = "credit-risk-bridge"
MCP_ENDPOINT = arg("--mcp-endpoint", "CREDIT_MCP_ENDPOINT", "http://localhost:8011")

CAP_CREDIT  = Web3.keccak(text="credit_review")
TOOL_ASSESS = Web3.keccak(text="assess_credit")


def _hex(b) -> str:
    if isinstance(b, bytes):
        return b.hex()
    return str(b).removeprefix("0x")


def _bytes(h: str) -> bytes:
    return bytes.fromhex(h.removeprefix("0x"))


async def _dispatch(oracle, agent_id: int, request_id: bytes, result: dict) -> None:
    """Dispatch the on-chain action indicated by the MCP tool result."""
    action = result.get("action")

    if action == "request_documents":
        logger.info("[%s]   → requestClientData  spec=%s", LABEL, result["spec_hash"])
        tx = await oracle.functions.requestClientData(
            request_id, agent_id, _bytes(result["spec_hash"])
        ).transact()
        logger.info("[%s]   ✓ requestClientData  tx=%s", LABEL, tx.hex())

    elif action == "propose_terms":
        logger.info("[%s]   → proposeTerms  hash=%s", LABEL, result["terms_hash"])
        tx = await oracle.functions.proposeTerms(
            request_id, agent_id, _bytes(result["terms_hash"])
        ).transact()
        logger.info("[%s]   ✓ proposeTerms  tx=%s", LABEL, tx.hex())

    elif action == "accept_terms":
        logger.info("[%s]   → acceptTerms  agreed=%s", LABEL, result["agreed_hash"])
        tx1 = await oracle.functions.acceptTerms(
            request_id, agent_id, _bytes(result["agreed_hash"])
        ).transact()
        logger.info("[%s]   ✓ acceptTerms  tx=%s", LABEL, tx1.hex())
        # After accepting, submit recommendation
        req = await oracle.functions.getRequest(request_id).call()
        result_hash = Web3.keccak(text=f"credit-result:{_hex(req[0])}")
        tx2 = await oracle.functions.submitRecommendation(
            request_id, agent_id, result_hash
        ).transact()
        logger.info("[%s]   ✓ submitRecommendation  tx=%s", LABEL, tx2.hex())

    elif action == "submit_recommendation":
        logger.info("[%s]   → submitRecommendation  approved=%s", LABEL, result.get("approved"))
        tx = await oracle.functions.submitRecommendation(
            request_id, agent_id, _bytes(result["result_hash"])
        ).transact()
        logger.info("[%s]   ✓ submitRecommendation  tx=%s", LABEL, tx.hex())


async def _handle_review_requested(oracle, agent_id: int, contracts: dict, event) -> None:
    args = event["args"]
    request_id, flow_id = args["requestId"], args["flowId"]
    client_agent_id     = args["clientAgentId"]
    trace_id = _hex(flow_id)

    logger.info("\n[%s] ← CreditReviewRequested  requestId=%s  flowId=%s", LABEL, _hex(request_id), trace_id)

    if not await governance_preflight(
        LABEL, flow_id=flow_id, agent_id=agent_id,
        capability=CAP_CREDIT, tool_hash=TOOL_ASSESS, contracts=contracts,
    ):
        return

    try:
        result = await call_mcp_tool(
            MCP_ENDPOINT, "assess_credit",
            {"flow_id": trace_id, "request_id": _hex(request_id), "client_agent_id": str(client_agent_id)},
            trace_id,
        )
        await _dispatch(oracle, agent_id, request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id)), result)
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def _handle_data_fulfilled(oracle, agent_id: int, contracts: dict, event) -> None:
    args = event["args"]
    request_id, flow_id = args["requestId"], args["flowId"]
    data_hash        = args["dataHash"]
    submitting_agent = args["submittingAgentId"]
    trace_id         = _hex(flow_id)

    if submitting_agent == agent_id:
        return

    logger.info("\n[%s] ← DataFulfilled  requestId=%s", LABEL, _hex(request_id))

    if not await governance_preflight(
        LABEL, flow_id=flow_id, agent_id=agent_id,
        capability=CAP_CREDIT, tool_hash=TOOL_ASSESS, contracts=contracts,
    ):
        return

    try:
        req    = await oracle.functions.getRequest(request_id).call()
        result = await call_mcp_tool(
            MCP_ENDPOINT, "continue_assessment",
            {
                "flow_id": trace_id, "request_id": _hex(request_id),
                "trigger": "data_fulfilled", "data_hash": _hex(data_hash),
                "current_round": int(req[7]),  # negotiationRound
            },
            trace_id,
        )
        req_bytes = request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id))
        await _dispatch(oracle, agent_id, req_bytes, result)
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def _handle_counter_proposed(oracle, agent_id: int, contracts: dict, event) -> None:
    args = event["args"]
    request_id, flow_id = args["requestId"], args["flowId"]
    proposal_hash = args["proposalHash"]
    trace_id      = _hex(flow_id)

    logger.info("\n[%s] ← CounterProposed  requestId=%s  proposal=%s", LABEL, _hex(request_id), _hex(proposal_hash))

    if not await governance_preflight(
        LABEL, flow_id=flow_id, agent_id=agent_id,
        capability=CAP_CREDIT, tool_hash=TOOL_ASSESS, contracts=contracts,
    ):
        return

    try:
        req    = await oracle.functions.getRequest(request_id).call()
        result = await call_mcp_tool(
            MCP_ENDPOINT, "continue_assessment",
            {
                "flow_id": trace_id, "request_id": _hex(request_id),
                "trigger": "counter_proposed", "data_hash": _hex(proposal_hash),
                "current_round": int(req[7]),
            },
            trace_id,
        )
        req_bytes = request_id if isinstance(request_id, bytes) else _bytes(_hex(request_id))
        await _dispatch(oracle, agent_id, req_bytes, result)
    except Exception as exc:
        logger.error("[%s]   ✗ %s", LABEL, exc)


async def main() -> None:
    ctx = await bootstrap_bridge(
        LABEL,
        contract_flag="--contract",
        contract_env="CREDIT_CONTRACT_ADDRESS",
        agent_id_env="CREDIT_AGENT_ID",
        card_glob="bank-credit-risk-agent.json",
    )

    oracle = ctx.w3.eth.contract(address=ctx.contract_address, abi=CREDIT_ORACLE_ABI)
    logger.info("[%s] MCP endpoint : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] Listening for CreditRiskOracle events…", LABEL)

    review_filter   = await oracle.events.CreditReviewRequested.create_filter(from_block="latest")
    data_filter     = await oracle.events.DataFulfilled.create_filter(from_block="latest")
    counter_filter  = await oracle.events.CounterProposed.create_filter(from_block="latest")

    while True:
        for event in await review_filter.get_new_entries():
            asyncio.create_task(_handle_review_requested(oracle, ctx.agent_id, ctx.contracts, event))
        for event in await data_filter.get_new_entries():
            asyncio.create_task(_handle_data_fulfilled(oracle, ctx.agent_id, ctx.contracts, event))
        for event in await counter_filter.get_new_entries():
            asyncio.create_task(_handle_counter_proposed(oracle, ctx.agent_id, ctx.contracts, event))
        await asyncio.sleep(2)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
