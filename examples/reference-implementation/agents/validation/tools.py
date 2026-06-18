"""Phase 3 - Validation & Compliance business logic.

Computes the four-dimension composite risk score and an escalation
recommendation. This is a *draft* assessment (not yet a canonical
validation-compliance document) - the orchestrator owns the mandatory
HITL gate and assembles the final schema-conformant artifact once a
decision (automatic for low risk, human for high/critical) is recorded.
See spec/v0.1.0/schemas/validation-compliance.schema.json.
"""
from __future__ import annotations

DIMENSION_WEIGHTS = {
    "financial_risk": 0.25,
    "operational_risk": 0.20,
    "compliance_risk": 0.35,
    "security_risk": 0.20,
}

REGULATORY_COMPLIANCE_PROFILES = {
    "financial_services_eu": ["GDPR", "DORA"],
    "financial_services_us": ["SR-11-7", "BCBS-239"],
    "financial_services_apac": ["BCBS-239"],
    "financial_services_global": ["BCBS-239", "PCI-DSS"],
}


def _risk_tier(score: float) -> str:
    if score >= 0.75:
        return "critical"
    if score >= 0.5:
        return "high"
    if score >= 0.3:
        return "medium"
    return "low"


def _escalation_outcome(tier: str, score: float, policy_violation: bool) -> tuple[str, bool]:
    if policy_violation:
        return "rejected", True
    if tier in ("high", "critical"):
        return "hitl_pending", True
    if tier == "medium" and score >= 0.4:
        return "approved_with_enhanced_monitoring", True
    return "approved", True


def handle_assess(args: dict) -> dict:
    plan = args.get("plan") or {}
    contract = args.get("contract") or {}
    task_data = args.get("task_data") or {}

    account_value = float(task_data.get("account_value") or 0)
    documents = task_data.get("verification_documents") or []
    force_violation = bool(task_data.get("force_policy_violation"))
    regulatory_profile = (contract.get("constraints") or {}).get(
        "regulatory_profile", "financial_services_global"
    )

    financial_risk = min(1.0, account_value / 500_000.0)
    operational_risk = 0.15 if (plan.get("negotiation") or {}).get("status") == "accepted" else 0.5
    compliance_risk = 0.95 if force_violation else (0.2 if regulatory_profile.endswith("eu") else 0.3)
    security_risk = 0.15 if len(documents) >= 2 else 0.6

    dims = {
        "financial_risk": round(financial_risk, 3),
        "operational_risk": round(operational_risk, 3),
        "compliance_risk": round(compliance_risk, 3),
        "security_risk": round(security_risk, 3),
    }
    composite = round(sum(dims[k] * DIMENSION_WEIGHTS[k] for k in dims), 3)
    tier = _risk_tier(composite)
    escalation_outcome, hitl_required = _escalation_outcome(tier, composite, force_violation)

    policy_checks = ["sanctions_screening", "kyc_verification", "data_residency_check"]
    if force_violation:
        policy_checks.append("sanctions_screening_failed")

    if force_violation:
        validation_status_recommendation = "rejected"
    elif escalation_outcome == "hitl_pending":
        validation_status_recommendation = None  # awaiting human decision
    else:
        validation_status_recommendation = "approved"

    return {
        "plan_id": plan.get("plan_id"),
        "policy_checks": policy_checks,
        "compliance_profiles": REGULATORY_COMPLIANCE_PROFILES.get(regulatory_profile, ["BCBS-239"]),
        "policy_violation": force_violation,
        "validation_status_recommendation": validation_status_recommendation,
        "risk_assessment": {
            "composite_risk_score": composite,
            "risk_tier": tier,
            "dimension_scores": dims,
            "dimension_weights": DIMENSION_WEIGHTS,
            "escalation_outcome": escalation_outcome,
            "hitl_required": hitl_required,
            **({"override_ref": "demo-board-approval-001"} if tier == "critical" else {}),
        },
    }


TOOL_HANDLERS = {"validation.assess": handle_assess}
