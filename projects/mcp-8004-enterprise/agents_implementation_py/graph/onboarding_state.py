"""
onboarding_state.py — OnboardingState TypedDict for the LangGraph StateGraph.

Phase bitmask mirrors OnboardingRegistry's 6-bit bitmask:
  Bit 0 (0x01): AML_DONE
  Bit 1 (0x02): CREDIT_DONE
  Bit 2 (0x04): LEGAL_DONE
  Bit 3 (0x08): ENTITY_SETUP_DONE
  Bit 4 (0x10): ACCOUNT_SETUP_DONE
  Bit 5 (0x20): PRODUCTS_SETUP_DONE
  ALL_REVIEWS_DONE = 0x07 (bits 0-2)
  ALL_DONE         = 0x3F (all 6 bits)
"""

from __future__ import annotations

from typing import Literal, Optional

from typing_extensions import TypedDict


class OnboardingState(TypedDict, total=False):
    # ── Core identifiers ────────────────────────────────────────────────────────
    flow_id:   str   # bytes32 hex (0x-prefixed) — onboarding flow ID
    trace_id:  str   # same as flow_id in this architecture

    # ── On-chain addresses ───────────────────────────────────────────────────────
    client_address: str

    # ── Agent IDs ────────────────────────────────────────────────────────────────
    bank_aml_agent_id:    str
    bank_credit_agent_id: str
    bank_legal_agent_id:  str
    hf_doc_agent_id:      str
    hf_credit_agent_id:   str
    hf_legal_agent_id:    str

    # ── On-chain request IDs ──────────────────────────────────────────────────────
    aml_request_id:    Optional[str]
    credit_request_id: Optional[str]
    legal_request_id:  Optional[str]

    # ── Phase tracking (mirrors on-chain bitmask) ─────────────────────────────────
    phase_bitmask: int   # current on-chain bitmask (0x00 – 0x3F)

    # ── Review statuses ───────────────────────────────────────────────────────────
    aml_status: Literal[
        "pending",
        "data_requested",
        "cleared",
        "rejected",
        "error",
    ]
    credit_status: Literal[
        "pending",
        "data_requested",
        "terms_proposed",
        "counter_proposed",
        "approved",
        "rejected",
        "error",
    ]
    legal_status: Literal[
        "pending",
        "draft_issued",
        "markup_received",
        "human_review",
        "approved",
        "rejected",
        "error",
    ]

    # ── Loop counters ─────────────────────────────────────────────────────────────
    aml_data_round:          int
    credit_negotiation_round: int
    legal_markup_round:       int

    # ── Result hashes (off-chain values, recorded here for inspection) ─────────────
    aml_result_hash:    Optional[str]
    credit_terms_hash:  Optional[str]
    legal_draft_hash:   Optional[str]

    # ── Flow control ──────────────────────────────────────────────────────────────
    terminated: bool   # True if any critical phase fails


# ── Bitmask constants (must match OnboardingRegistry.sol) ─────────────────────

PHASE_AML_DONE          = 0x01
PHASE_CREDIT_DONE       = 0x02
PHASE_LEGAL_DONE        = 0x04
ALL_REVIEWS_DONE        = 0x07  # bits 0-2
PHASE_ENTITY_SETUP_DONE = 0x08
PHASE_ACCOUNT_SETUP_DONE= 0x10
PHASE_PRODUCTS_DONE     = 0x20
ALL_DONE                = 0x3F


def initial_state(
    flow_id: str,
    client_address: str,
    bank_aml_agent_id: str = "0",
    bank_credit_agent_id: str = "1",
    bank_legal_agent_id: str = "2",
    hf_doc_agent_id: str = "7",
    hf_credit_agent_id: str = "8",
    hf_legal_agent_id: str = "9",
) -> OnboardingState:
    """Build the initial graph state for a new onboarding flow."""
    return OnboardingState(
        flow_id=flow_id,
        trace_id=flow_id,
        client_address=client_address,
        bank_aml_agent_id=bank_aml_agent_id,
        bank_credit_agent_id=bank_credit_agent_id,
        bank_legal_agent_id=bank_legal_agent_id,
        hf_doc_agent_id=hf_doc_agent_id,
        hf_credit_agent_id=hf_credit_agent_id,
        hf_legal_agent_id=hf_legal_agent_id,
        aml_request_id=None,
        credit_request_id=None,
        legal_request_id=None,
        phase_bitmask=0,
        aml_status="pending",
        credit_status="pending",
        legal_status="pending",
        aml_data_round=0,
        credit_negotiation_round=0,
        legal_markup_round=0,
        aml_result_hash=None,
        credit_terms_hash=None,
        legal_draft_hash=None,
        terminated=False,
    )
