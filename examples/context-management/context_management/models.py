"""Pydantic v2 models for OpenEAGO workflow context.

Aligned with the normative risk/compliance model defined in
docs/overview/risk-management.md and the OpenEAGO Phase 5 proposal.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class JournalEntry(BaseModel):
    """Append-only audit event recorded by an agent."""

    timestamp: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    agent_id: str
    task_id: str
    event_type: Literal["claimed", "started", "completed", "failed", "retry", "escalated"]
    outcome: Optional[Dict[str, Any]] = None
    risk_delta: Optional[Dict[str, Any]] = None


class RiskDimension(BaseModel):
    """Per-dimension risk scores (0.0–1.0).

    Weights are normative constants from docs/overview/risk-management.md:
      financial=0.25, operational=0.20, compliance=0.30, security=0.25
    """

    financial: float = 0.0    # weight 0.25
    operational: float = 0.0  # weight 0.20
    compliance: float = 0.0   # weight 0.30
    security: float = 0.0     # weight 0.25


class RiskContext(BaseModel):
    """Aggregated risk state for the workflow."""

    composite_score: float = 0.0
    tier: Literal["low", "medium", "high", "critical"] = "low"
    dimensions: RiskDimension = Field(default_factory=RiskDimension)
    events: List[Dict[str, Any]] = Field(default_factory=list)

    @staticmethod
    def compute_composite(d: RiskDimension) -> float:
        """Weighted composite risk score per normative spec."""
        return (
            d.financial * 0.25
            + d.operational * 0.20
            + d.compliance * 0.30
            + d.security * 0.25
        )

    @staticmethod
    def score_to_tier(score: float) -> str:
        """Map composite score to normative risk tier.

        Thresholds from docs/overview/risk-management.md:
          < 0.40 → low
          < 0.60 → medium
          < 0.80 → high
          >= 0.80 → critical
        """
        if score < 0.40:
            return "low"
        if score < 0.60:
            return "medium"
        if score < 0.80:
            return "high"
        return "critical"


class WorkflowContext(BaseModel):
    """Read-only Pydantic snapshot of a WorkflowContextStore.

    Mirrors LangGraph state patterns (append-only journal, map-based playbook)
    but is produced from a CRDT-backed document — never mutated directly.
    """

    workflow_id: str
    goal: str
    objective_details: Dict[str, Any] = Field(default_factory=dict)
    journal: List[JournalEntry] = Field(default_factory=list)
    playbook: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    risk: RiskContext = Field(default_factory=RiskContext)
    plan: Dict[str, Any] = Field(default_factory=dict)
    agents: Dict[str, Dict[str, Any]] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)
