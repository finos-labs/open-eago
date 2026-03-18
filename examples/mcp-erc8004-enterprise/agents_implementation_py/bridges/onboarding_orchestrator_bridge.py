"""
onboarding_orchestrator_bridge.py — LangGraph runner for the onboarding flow.
Port of onboarding-orchestrator-bridge.js, extended with LangGraph StateGraph.

Responsibilities:
  1. Expose POST /initiate REST endpoint for flow initiation
  2. Run the LangGraph onboarding_graph for each flow
  3. Watch on-chain events and inject state changes to resume the graph:
       - AML DataFulfilled       → {"aml_status": "data_requested"} (actually data arrived)
       - Credit CounterProposed  → {"credit_status": "counter_proposed", ...}
       - Legal MarkupSubmitted   → {"legal_status": "markup_received", ...}
       - PhaseCompleted          → {"phase_bitmask": <new_mask>}
  4. Provide GET /state/{flow_id} for graph state inspection

Usage:
    python -m bridges.onboarding_orchestrator_bridge \
        --onboarding-registry 0x... \
        --aml-contract 0x... --credit-contract 0x... --legal-contract 0x... \
        --rpc http://... --privkey 0x...

ENV: ONBOARDING_REGISTRY_ADDRESS, AML_CONTRACT_ADDRESS, CREDIT_CONTRACT_ADDRESS,
     LEGAL_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from typing import Any

from langgraph.types import Command
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
import uvicorn

from graph.onboarding_graph import build_graph
from graph.onboarding_state import OnboardingState, initial_state
from graph.nodes import initiate_node as _initiate_module
from shared.abis import (
    AML_ORACLE_ABI,
    CREDIT_ORACLE_ABI,
    LEGAL_ORACLE_ABI,
    ONBOARDING_REGISTRY_ABI,
)
from shared.bridge_base import arg, build_web3, call_mcp_tool
from shared.vault_signer import create_signer

logger = logging.getLogger(__name__)

LABEL       = "orchestrator-bridge"
TRIGGER_PORT = int(arg("--trigger-port", "ORCHESTRATOR_PORT", "9000"))
MCP_ENDPOINT = arg("--mcp-endpoint", "ORCHESTRATOR_MCP_ENDPOINT", "http://localhost:8013")

RPC_URL       = arg("--rpc",          "RPC_URL",             "http://127.0.0.1:8545")
PRIVATE_KEY   = arg("--privkey",      "ORACLE_PRIVATE_KEY")
SIGNER_TYPE   = arg("--signer-type",  "SIGNER_TYPE",         "local")
VAULT_URL     = arg("--vault-url",    "VAULT_URL")
VAULT_ADDRESS = arg("--vault-address","ORACLE_ADDRESS")

ONBOARDING_REG   = arg("--onboarding-registry", "ONBOARDING_REGISTRY_ADDRESS")
AML_CONTRACT     = arg("--aml-contract",         "AML_CONTRACT_ADDRESS")
CREDIT_CONTRACT  = arg("--credit-contract",      "CREDIT_CONTRACT_ADDRESS")
LEGAL_CONTRACT   = arg("--legal-contract",       "LEGAL_CONTRACT_ADDRESS")


# ── Graph singleton ────────────────────────────────────────────────────────────

_graph = build_graph()   # uses MemorySaver for dev

_w3:            Any = None
_onboarding_reg: Any = None
_aml_oracle:    Any = None
_credit_oracle: Any = None
_legal_oracle:  Any = None


def _thread_config(flow_id: str) -> dict:
    return {"configurable": {"thread_id": flow_id}}


# ── Initiate flow ─────────────────────────────────────────────────────────────

async def _initiate_flow(params: dict) -> dict:
    flow_id        = params.get("flowId") or params.get("flow_id")
    client_address = params.get("clientAddress") or params.get("client_address")

    if not flow_id or not client_address:
        raise ValueError("flowId and clientAddress required")

    # Optional: call orchestrator MCP server for planning/logging
    try:
        plan = await call_mcp_tool(
            MCP_ENDPOINT, "initiate_onboarding",
            {
                "flow_id":              flow_id,
                "client_address":       client_address,
                "bank_aml_agent_id":    params.get("bankAmlAgentId",    "0"),
                "bank_credit_agent_id": params.get("bankCreditAgentId", "1"),
                "bank_legal_agent_id":  params.get("bankLegalAgentId",  "2"),
                "hf_doc_agent_id":      params.get("hfDocAgentId",      "7"),
                "hf_credit_agent_id":   params.get("hfCreditAgentId",   "8"),
                "hf_legal_agent_id":    params.get("hfLegalAgentId",    "9"),
            },
            flow_id,
        )
        logger.info("[%s] Plan: %s", LABEL, plan)
    except Exception as exc:
        logger.warning("[%s] Orchestrator MCP unavailable: %s", LABEL, exc)

    # Build initial state and run the graph
    state = initial_state(
        flow_id=flow_id,
        client_address=client_address,
        bank_aml_agent_id=params.get("bankAmlAgentId", "0"),
        bank_credit_agent_id=params.get("bankCreditAgentId", "1"),
        bank_legal_agent_id=params.get("bankLegalAgentId", "2"),
        hf_doc_agent_id=params.get("hfDocAgentId", "7"),
        hf_credit_agent_id=params.get("hfCreditAgentId", "8"),
        hf_legal_agent_id=params.get("hfLegalAgentId", "9"),
    )

    config = _thread_config(flow_id)
    asyncio.create_task(_run_graph(state, config))

    return {"flow_id": flow_id, "status": "initiated"}


async def _run_graph(state: OnboardingState, config: dict) -> None:
    """Launch the graph for a new flow (runs in background task)."""
    try:
        await _graph.ainvoke(state, config)
    except Exception as exc:
        logger.error("[%s] Graph error for flow=%s: %s", LABEL, state.get("flow_id"), exc)


# ── On-chain event handlers (inject state into paused graph) ──────────────────

async def _watch_events() -> None:
    """Poll on-chain events and inject state updates to resume paused graphs."""
    aml_data_filter    = await _aml_oracle.events.DataFulfilled.create_filter(from_block="latest")
    credit_counter_fil = await _credit_oracle.events.CounterProposed.create_filter(from_block="latest")
    legal_markup_fil   = await _legal_oracle.events.MarkupSubmitted.create_filter(from_block="latest")
    phase_filter       = await _onboarding_reg.events.PhaseCompleted.create_filter(from_block="latest")

    while True:
        for event in await aml_data_filter.get_new_entries():
            asyncio.create_task(_on_aml_data_fulfilled(event))
        for event in await credit_counter_fil.get_new_entries():
            asyncio.create_task(_on_credit_counter_proposed(event))
        for event in await legal_markup_fil.get_new_entries():
            asyncio.create_task(_on_legal_markup_submitted(event))
        for event in await phase_filter.get_new_entries():
            asyncio.create_task(_on_phase_completed(event))
        await asyncio.sleep(2)


def _flow_hex(flow_id) -> str:
    return flow_id.hex() if isinstance(flow_id, bytes) else str(flow_id).removeprefix("0x")


async def _on_aml_data_fulfilled(event) -> None:
    args     = event["args"]
    flow_id  = _flow_hex(args["flowId"])
    data_hash = args["dataHash"]
    config   = _thread_config(flow_id)
    logger.info("[%s] ← DataFulfilled (AML)  flow=%s", LABEL, flow_id)
    await _graph.aupdate_state(config, {
        "aml_status":   "pending",  # reset to pending so aml_node calls continue_screening
    })
    await _graph.ainvoke(Command(resume=True), config)


async def _on_credit_counter_proposed(event) -> None:
    args         = event["args"]
    flow_id      = _flow_hex(args["flowId"])
    proposal_hash = args["proposalHash"]
    config       = _thread_config(flow_id)
    logger.info("[%s] ← CounterProposed  flow=%s", LABEL, flow_id)
    await _graph.aupdate_state(config, {
        "credit_status":    "counter_proposed",
        "credit_terms_hash": proposal_hash.hex() if isinstance(proposal_hash, bytes) else proposal_hash,
    })
    await _graph.ainvoke(Command(resume=True), config)


async def _on_legal_markup_submitted(event) -> None:
    args        = event["args"]
    flow_id     = _flow_hex(args["flowId"])
    markup_hash = args["markupHash"]
    round_num   = args["round"]
    config      = _thread_config(flow_id)
    logger.info("[%s] ← MarkupSubmitted  flow=%s  round=%s", LABEL, flow_id, round_num)
    await _graph.aupdate_state(config, {
        "legal_status":    "markup_received",
        "legal_draft_hash": markup_hash.hex() if isinstance(markup_hash, bytes) else markup_hash,
        "legal_markup_round": int(round_num),
    })
    await _graph.ainvoke(Command(resume=True), config)


async def _on_phase_completed(event) -> None:
    args    = event["args"]
    flow_id = _flow_hex(args["flowId"])
    phase   = args["phase"]
    mask    = await _onboarding_reg.functions.phaseBitmask(args["flowId"]).call()
    config  = _thread_config(flow_id)
    logger.info("[%s] ← PhaseCompleted  flow=%s  mask=0x%02x", LABEL, flow_id, mask)
    await _graph.aupdate_state(config, {"phase_bitmask": int(mask)})
    await _graph.ainvoke(Command(resume=True), config)


# ── REST API (Starlette) ───────────────────────────────────────────────────────

async def _handle_initiate(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON"}, status_code=400)
    try:
        result = await _initiate_flow(body)
        return JSONResponse(result)
    except Exception as exc:
        logger.error("[%s] ✗ %s", LABEL, exc)
        return JSONResponse({"error": str(exc)}, status_code=500)


async def _handle_state(request: Request) -> JSONResponse:
    flow_id = request.path_params["flow_id"]
    try:
        state = await _graph.aget_state(_thread_config(flow_id))
        return JSONResponse({"flow_id": flow_id, "values": state.values})
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=404)


# ── Main ───────────────────────────────────────────────────────────────────────

async def main() -> None:
    global _w3, _onboarding_reg, _aml_oracle, _credit_oracle, _legal_oracle

    for name, val in [("--onboarding-registry", ONBOARDING_REG), ("--aml-contract", AML_CONTRACT),
                      ("--credit-contract", CREDIT_CONTRACT), ("--legal-contract", LEGAL_CONTRACT)]:
        if not val:
            logger.error("[%s] Missing %s", LABEL, name); sys.exit(1)
    if SIGNER_TYPE == "local" and not PRIVATE_KEY:
        logger.error("[%s] Missing --privkey", LABEL); sys.exit(1)

    signer = create_signer(SIGNER_TYPE, PRIVATE_KEY, VAULT_URL, VAULT_ADDRESS)
    _w3, _ = build_web3(RPC_URL, signer)

    _onboarding_reg = _w3.eth.contract(address=ONBOARDING_REG, abi=ONBOARDING_REGISTRY_ABI)
    _aml_oracle     = _w3.eth.contract(address=AML_CONTRACT,   abi=AML_ORACLE_ABI)
    _credit_oracle  = _w3.eth.contract(address=CREDIT_CONTRACT,abi=CREDIT_ORACLE_ABI)
    _legal_oracle   = _w3.eth.contract(address=LEGAL_CONTRACT, abi=LEGAL_ORACLE_ABI)

    # Configure initiate_node with web3 contracts
    _initiate_module.configure(
        _w3, _onboarding_reg, _aml_oracle, _credit_oracle, _legal_oracle
    )

    logger.info("[%s] Signer             : %s", LABEL, signer.address)
    logger.info("[%s] OnboardingRegistry : %s", LABEL, ONBOARDING_REG)
    logger.info("[%s] AMLOracle          : %s", LABEL, AML_CONTRACT)
    logger.info("[%s] CreditRiskOracle   : %s", LABEL, CREDIT_CONTRACT)
    logger.info("[%s] LegalOracle        : %s", LABEL, LEGAL_CONTRACT)
    logger.info("[%s] MCP endpoint       : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] REST trigger port  : %d", LABEL, TRIGGER_PORT)

    # Start event watcher background task
    asyncio.create_task(_watch_events())

    # Start REST server
    app = Starlette(routes=[
        Route("/initiate", _handle_initiate, methods=["POST"]),
        Route("/state/{flow_id}", _handle_state, methods=["GET"]),
    ])

    config = uvicorn.Config(app, host="0.0.0.0", port=TRIGGER_PORT, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
