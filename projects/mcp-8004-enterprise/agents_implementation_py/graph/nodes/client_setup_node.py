"""
client_setup_node.py — LangGraph node: CLIENT_SETUP_NODE

Sequential execution:
  1. setup_legal_entity → wait for ENTITY_SETUP_DONE bit
  2. setup_account      → wait for ACCOUNT_SETUP_DONE bit
  3. setup_products     → wait for PRODUCTS_SETUP_DONE bit

Each step is triggered by a PhaseCompleted event injected via update_state.
State field "phase_bitmask" tracks current on-chain phase.
"""

from __future__ import annotations

import logging

from langgraph.types import interrupt

from graph.onboarding_state import (
    ALL_REVIEWS_DONE,
    PHASE_ENTITY_SETUP_DONE,
    PHASE_ACCOUNT_SETUP_DONE,
    PHASE_PRODUCTS_DONE,
    OnboardingState,
)
from shared.bridge_base import call_mcp_tool

logger = logging.getLogger(__name__)

SETUP_MCP_ENDPOINT = "http://localhost:8014"


async def client_setup_node(state: OnboardingState) -> dict:
    flow_id  = state["flow_id"]
    mask     = state.get("phase_bitmask", 0)
    trace_id = state.get("trace_id", flow_id)

    logger.info("[setup-node] flow=%s mask=0x%02x", flow_id, mask)

    # ── Step 1: Legal entity setup ───────────────────────────────────────────────
    if (mask & PHASE_ENTITY_SETUP_DONE) == 0:
        logger.info("[setup-node] → setup_legal_entity")
        result = await call_mcp_tool(
            SETUP_MCP_ENDPOINT, "setup_legal_entity",
            {"flow_id": flow_id}, trace_id,
        )
        logger.info("[setup-node] ✓ entity_spec_hash=%s", result["entity_spec_hash"])
        # Wait for ENTITY_SETUP_DONE bit to be set on-chain
        interrupt("setup: waiting for ENTITY_SETUP_DONE phase event")
        return {"phase_bitmask": mask | PHASE_ENTITY_SETUP_DONE}

    # ── Step 2: Account setup ────────────────────────────────────────────────────
    if (mask & PHASE_ACCOUNT_SETUP_DONE) == 0:
        logger.info("[setup-node] → setup_account")
        result = await call_mcp_tool(
            SETUP_MCP_ENDPOINT, "setup_account",
            {"flow_id": flow_id}, trace_id,
        )
        logger.info("[setup-node] ✓ account_spec_hash=%s", result["account_spec_hash"])
        interrupt("setup: waiting for ACCOUNT_SETUP_DONE phase event")
        return {"phase_bitmask": mask | PHASE_ACCOUNT_SETUP_DONE}

    # ── Step 3: Products setup ───────────────────────────────────────────────────
    if (mask & PHASE_PRODUCTS_DONE) == 0:
        logger.info("[setup-node] → setup_products")
        result = await call_mcp_tool(
            SETUP_MCP_ENDPOINT, "setup_products",
            {"flow_id": flow_id}, trace_id,
        )
        logger.info("[setup-node] ✓ product_spec_hash=%s", result["product_spec_hash"])
        return {"phase_bitmask": mask | PHASE_PRODUCTS_DONE}

    # All done — 0x3F
    logger.info("[setup-node] ✓ all setup phases complete (bitmask=0x3F)")
    return {}
