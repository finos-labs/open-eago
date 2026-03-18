"""
initiate_node.py — LangGraph node: INITIATE_FLOW

Responsibilities:
  1. Call OnboardingRegistry.initiateOnboarding(flowId, clientAddress)
  2. Open AML, Credit, and Legal review requests in parallel
  3. Return updated state with request IDs and pending statuses

This node runs once at the start of the graph.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from graph.onboarding_state import OnboardingState

logger = logging.getLogger(__name__)


async def initiate_node(state: OnboardingState) -> dict:
    """
    LangGraph node: initiate onboarding flow on-chain.

    Reads web3 context from environment/config (injected by the bridge).
    Returns state delta to merge into OnboardingState.
    """
    flow_id        = state["flow_id"]
    client_address = state["client_address"]

    logger.info("[initiate-node] flow=%s client=%s", flow_id, client_address)

    # Retrieve web3 context injected by the bridge runner
    w3             = _get_w3()
    onboarding_reg = _get_onboarding_reg(w3)
    aml_oracle     = _get_aml_oracle(w3)
    credit_oracle  = _get_credit_oracle(w3)
    legal_oracle   = _get_legal_oracle(w3)

    flow_bytes = bytes.fromhex(flow_id.removeprefix("0x"))

    # 1. initiateOnboarding
    logger.info("[initiate-node] → initiateOnboarding flowId=%s", flow_id)
    tx = await onboarding_reg.functions.initiateOnboarding(
        flow_bytes, client_address
    ).transact()
    logger.info("[initiate-node] ✓ initiateOnboarding tx=%s", tx.hex())

    # 2–4. Open all three review requests in parallel
    import asyncio
    bank_aml    = int(state.get("bank_aml_agent_id",    "0"))
    bank_credit = int(state.get("bank_credit_agent_id", "1"))
    bank_legal  = int(state.get("bank_legal_agent_id",  "2"))
    hf_doc      = int(state.get("hf_doc_agent_id",      "7"))
    hf_credit   = int(state.get("hf_credit_agent_id",   "8"))
    hf_legal    = int(state.get("hf_legal_agent_id",    "9"))

    logger.info("[initiate-node] → opening AML / Credit / Legal review requests…")

    aml_tx, credit_tx, legal_tx = await asyncio.gather(
        aml_oracle.functions.requestAMLReview(flow_bytes, bank_aml, hf_doc).transact(),
        credit_oracle.functions.requestCreditReview(flow_bytes, bank_credit, hf_credit).transact(),
        legal_oracle.functions.requestLegalReview(flow_bytes, bank_legal, hf_legal).transact(),
    )
    logger.info("[initiate-node] ✓ all review requests opened")

    # Request IDs are returned as return values, but for events we read from receipts
    # For now, store transaction hashes as placeholders (request IDs read from events)
    return {
        "aml_request_id":    aml_tx.hex(),
        "credit_request_id": credit_tx.hex(),
        "legal_request_id":  legal_tx.hex(),
        "aml_status":    "pending",
        "credit_status": "pending",
        "legal_status":  "pending",
    }


# ── Web3 context helpers (injected by bridge runner via module-level globals) ──

_w3_instance            = None
_onboarding_reg_instance = None
_aml_oracle_instance    = None
_credit_oracle_instance = None
_legal_oracle_instance  = None


def configure(w3, onboarding_reg, aml_oracle, credit_oracle, legal_oracle) -> None:
    """Called by the bridge runner before invoking the graph."""
    global _w3_instance, _onboarding_reg_instance
    global _aml_oracle_instance, _credit_oracle_instance, _legal_oracle_instance
    _w3_instance             = w3
    _onboarding_reg_instance = onboarding_reg
    _aml_oracle_instance     = aml_oracle
    _credit_oracle_instance  = credit_oracle
    _legal_oracle_instance   = legal_oracle


def _get_w3():
    if _w3_instance is None:
        raise RuntimeError("initiate_node not configured — call configure() first")
    return _w3_instance


def _get_onboarding_reg(w3):
    return _onboarding_reg_instance


def _get_aml_oracle(w3):
    return _aml_oracle_instance


def _get_credit_oracle(w3):
    return _credit_oracle_instance


def _get_legal_oracle(w3):
    return _legal_oracle_instance
