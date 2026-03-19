"""High-level WorkflowContextStore — the main interface agents use.

Each mutating operation is a single Automerge change transaction, making
all updates CRDT-safe.  The max-score merge policy for risk is enforced
in :meth:`merge_with` after the automatic CRDT merge.
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List, Optional

from .crdt_backend import (
    apply_change,
    create_doc,
    get_history,
    load_doc,
    merge_docs,
    save_doc,
)
from .models import JournalEntry, RiskContext, RiskDimension, WorkflowContext


class WorkflowContextStore:
    """CRDT-backed, high-level context store for one workflow."""

    def __init__(
        self,
        workflow_id: str,
        goal: str,
        **objective_details: Any,
    ) -> None:
        initial: dict = {
            "workflow_id": workflow_id,
            "goal": goal,
            "objective_details": dict(objective_details),
            "journal": [],
            "playbook": {},
            "risk": {
                "composite_score": 0.0,
                "tier": "low",
                "dimensions": {
                    "financial": 0.0,
                    "operational": 0.0,
                    "compliance": 0.0,
                    "security": 0.0,
                },
                "events": [],
            },
            "plan": {},
            "agents": {},
            "metadata": {},
        }
        self._doc = create_doc(initial)

    # ------------------------------------------------------------------
    # Write operations
    # ------------------------------------------------------------------

    def append_journal(self, entry: JournalEntry) -> None:
        """Append an audit event to the journal (naturally CRDT-safe)."""
        entry_dict = entry.model_dump()

        def _change(doc: Any) -> None:
            doc["journal"].append(entry_dict)

        self._doc = apply_change(self._doc, _change)

    def upsert_playbook(self, key: str, value: Dict[str, Any]) -> None:
        """Upsert a playbook entry (last-write-wins per Automerge map semantics)."""
        def _change(doc: Any) -> None:
            doc["playbook"][key] = value

        self._doc = apply_change(self._doc, _change)

    def update_risk(
        self,
        dimensions: RiskDimension,
        event: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Recompute composite score and tier, then persist.

        The max-score merge policy is enforced at merge time in
        :meth:`merge_with`; this method simply stores the local computation.
        """
        score = RiskContext.compute_composite(dimensions)
        tier = RiskContext.score_to_tier(score)
        dims_dict = dimensions.model_dump()

        def _change(doc: Any) -> None:
            doc["risk"]["composite_score"] = score
            doc["risk"]["tier"] = tier
            doc["risk"]["dimensions"] = dims_dict
            if event is not None:
                doc["risk"]["events"].append(event)

        self._doc = apply_change(self._doc, _change)

    def update_plan(self, patch: Dict[str, Any]) -> None:
        """Shallow-merge *patch* into the plan map."""
        def _change(doc: Any) -> None:
            for k, v in patch.items():
                doc["plan"][k] = v

        self._doc = apply_change(self._doc, _change)

    def register_agent(self, agent_id: str, metadata: Dict[str, Any]) -> None:
        """Upsert agent registration metadata."""
        def _change(doc: Any) -> None:
            doc["agents"][agent_id] = metadata

        self._doc = apply_change(self._doc, _change)

    # ------------------------------------------------------------------
    # CRDT merge
    # ------------------------------------------------------------------

    def merge_with(self, other: "WorkflowContextStore") -> None:
        """Merge *other* into this store.

        1. CRDT-merge the Automerge docs (journal/playbook handled automatically).
        2. Apply max-score policy for risk.composite_score post-merge.
        """
        self._doc = merge_docs(self._doc, other._doc)

        # Max-score policy: keep the highest composite_score observed across
        # all merged replicas and re-derive the tier from it.
        local_score: float = self._doc["risk"]["composite_score"]
        other_score: float = other._doc["risk"]["composite_score"]

        if other_score > local_score:
            winning_score = other_score
            winning_dims = dict(other._doc["risk"]["dimensions"])

            def _fix_risk(doc: Any) -> None:
                doc["risk"]["composite_score"] = winning_score
                doc["risk"]["tier"] = RiskContext.score_to_tier(winning_score)
                doc["risk"]["dimensions"] = winning_dims

            self._doc = apply_change(self._doc, _fix_risk)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self) -> bytes:
        """Serialize the Automerge document to bytes."""
        return save_doc(self._doc)

    @classmethod
    def load(cls, data: bytes) -> "WorkflowContextStore":
        """Deserialize a store from bytes produced by :meth:`save`."""
        instance = object.__new__(cls)
        instance._doc = load_doc(data)
        return instance

    # ------------------------------------------------------------------
    # Read
    # ------------------------------------------------------------------

    def snapshot(self) -> WorkflowContext:
        """Return a Pydantic snapshot of the current document state."""
        doc = self._doc

        risk_raw = doc["risk"]
        dims = RiskDimension(**dict(risk_raw["dimensions"]))
        risk = RiskContext(
            composite_score=float(risk_raw["composite_score"]),
            tier=risk_raw["tier"],  # type: ignore[arg-type]
            dimensions=dims,
            events=list(risk_raw["events"]),
        )

        journal = [JournalEntry(**dict(e)) for e in doc["journal"]]

        return WorkflowContext(
            workflow_id=doc["workflow_id"],
            goal=doc["goal"],
            objective_details=dict(doc.get("objective_details", {})),
            journal=journal,
            playbook={k: dict(v) for k, v in doc.get("playbook", {}).items()},
            risk=risk,
            plan=dict(doc.get("plan", {})),
            agents={k: dict(v) for k, v in doc.get("agents", {}).items()},
            metadata=dict(doc.get("metadata", {})),
        )

    def history(self) -> list[dict]:
        """Return Automerge change history for audit / blockchain anchoring."""
        return get_history(self._doc)
