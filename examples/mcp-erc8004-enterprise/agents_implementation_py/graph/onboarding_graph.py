"""
onboarding_graph.py — LangGraph StateGraph for the multi-phase onboarding flow.

Graph topology:
  START
    └─► INITIATE_FLOW
          │ fan-out (parallel)
          ├─► AML_NODE     ──┐ all cleared
          ├─► CREDIT_NODE    │ phase_bitmask & 0x07 == 0x07
          └─► LEGAL_NODE  ───► PHASE_GATE ──► CLIENT_SETUP_NODE ──► END
                                    │
                               terminated?
                                    └──► END

Conditional edges implement the status-driven loops:
  - AML:    cleared/rejected → PHASE_GATE; otherwise → AML_NODE (re-enter)
  - Credit: approved/rejected → PHASE_GATE; otherwise → CREDIT_NODE (re-enter)
  - Legal:  approved/rejected → PHASE_GATE; otherwise → LEGAL_NODE (re-enter)

Checkpointing:
  - MemorySaver (dev) — no external DB needed
  - Replace with PostgresSaver for production

Event injection (used by onboarding_orchestrator_bridge.py):
    config = {"configurable": {"thread_id": flow_id}}
    await graph.aupdate_state(config, {"credit_status": "counter_proposed"})
    await graph.ainvoke(Command(resume=True), config)
"""

from __future__ import annotations

import logging
from typing import Any

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command

from graph.onboarding_state import ALL_REVIEWS_DONE, PHASE_PRODUCTS_DONE, OnboardingState
from graph.nodes.aml_node import aml_node
from graph.nodes.client_setup_node import client_setup_node
from graph.nodes.credit_node import credit_node
from graph.nodes.initiate_node import initiate_node
from graph.nodes.legal_node import legal_node

logger = logging.getLogger(__name__)

# ── Routing functions ─────────────────────────────────────────────────────────

def _aml_route(state: OnboardingState) -> str:
    s = state.get("aml_status", "pending")
    if s in ("cleared", "rejected", "error"):
        return "phase_gate"
    return "aml"   # loop back (data_requested → interrupt inside node)


def _credit_route(state: OnboardingState) -> str:
    s = state.get("credit_status", "pending")
    if s in ("approved", "rejected", "error"):
        return "phase_gate"
    return "credit"


def _legal_route(state: OnboardingState) -> str:
    s = state.get("legal_status", "pending")
    if s in ("approved", "rejected", "error"):
        return "phase_gate"
    return "legal"


def _phase_gate_route(state: OnboardingState) -> str:
    """Proceed to client setup only when all three reviews complete successfully."""
    if state.get("terminated"):
        return END

    mask = state.get("phase_bitmask", 0)
    aml_ok    = state.get("aml_status")    == "cleared"
    credit_ok = state.get("credit_status") == "approved"
    legal_ok  = state.get("legal_status")  == "approved"

    if aml_ok and credit_ok and legal_ok:
        return "client_setup"

    # Some reviews failed or still pending — check for terminal failure
    any_failed = (
        state.get("aml_status")    in ("rejected", "error") or
        state.get("credit_status") in ("rejected", "error") or
        state.get("legal_status")  in ("rejected", "error")
    )
    if any_failed:
        return END

    # Still waiting — stay at phase_gate (will be re-evaluated)
    return END


async def _phase_gate_node(state: OnboardingState) -> dict:
    """
    PHASE_GATE: check whether all three review sub-workflows are done.
    Updates phase_bitmask with the reviews bitmask when cleared.
    """
    from graph.onboarding_state import PHASE_AML_DONE, PHASE_CREDIT_DONE, PHASE_LEGAL_DONE

    mask = state.get("phase_bitmask", 0)
    if state.get("aml_status") == "cleared":
        mask |= PHASE_AML_DONE
    if state.get("credit_status") == "approved":
        mask |= PHASE_CREDIT_DONE
    if state.get("legal_status") == "approved":
        mask |= PHASE_LEGAL_DONE

    terminated = state.get("terminated", False) or any(
        s in ("rejected", "error")
        for s in [
            state.get("aml_status"),
            state.get("credit_status"),
            state.get("legal_status"),
        ]
    )

    logger.info(
        "[phase-gate] aml=%s credit=%s legal=%s mask=0x%02x terminated=%s",
        state.get("aml_status"),
        state.get("credit_status"),
        state.get("legal_status"),
        mask,
        terminated,
    )
    return {"phase_bitmask": mask, "terminated": terminated}


def _setup_route(state: OnboardingState) -> str:
    mask = state.get("phase_bitmask", 0)
    if (mask & PHASE_PRODUCTS_DONE) == PHASE_PRODUCTS_DONE:
        return END
    return "client_setup"


# ── Graph builder ─────────────────────────────────────────────────────────────

def build_graph(checkpointer=None) -> Any:
    """
    Build and compile the onboarding StateGraph.

    Args:
        checkpointer: LangGraph checkpointer (MemorySaver for dev,
                      PostgresSaver for prod). Defaults to MemorySaver.

    Returns:
        Compiled LangGraph graph (CompiledGraph).
    """
    if checkpointer is None:
        checkpointer = MemorySaver()

    workflow = StateGraph(OnboardingState)

    # ── Register nodes ────────────────────────────────────────────────────────
    workflow.add_node("initiate", initiate_node)
    workflow.add_node("aml",      aml_node)
    workflow.add_node("credit",   credit_node)
    workflow.add_node("legal",    legal_node)
    workflow.add_node("phase_gate",    _phase_gate_node)
    workflow.add_node("client_setup",  client_setup_node)

    # ── Entry edge ────────────────────────────────────────────────────────────
    workflow.add_edge(START, "initiate")

    # ── Fan-out: initiate → parallel review nodes ─────────────────────────────
    workflow.add_edge("initiate", "aml")
    workflow.add_edge("initiate", "credit")
    workflow.add_edge("initiate", "legal")

    # ── Conditional edges: review loops + exit to phase_gate ─────────────────
    workflow.add_conditional_edges(
        "aml",
        _aml_route,
        {"aml": "aml", "phase_gate": "phase_gate"},
    )
    workflow.add_conditional_edges(
        "credit",
        _credit_route,
        {"credit": "credit", "phase_gate": "phase_gate"},
    )
    workflow.add_conditional_edges(
        "legal",
        _legal_route,
        {"legal": "legal", "phase_gate": "phase_gate"},
    )

    # ── Phase gate → client setup or END ──────────────────────────────────────
    workflow.add_conditional_edges(
        "phase_gate",
        _phase_gate_route,
        {"client_setup": "client_setup", END: END},
    )

    # ── Client setup loop (sequential steps via interrupt) ────────────────────
    workflow.add_conditional_edges(
        "client_setup",
        _setup_route,
        {"client_setup": "client_setup", END: END},
    )

    return workflow.compile(checkpointer=checkpointer)
