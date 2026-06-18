"""Phase 1 - Contract Management business logic.

Validates the inbound task request and enriches it into an OASF-aligned
contract matching spec/v0.1.0/schemas/contract-management.schema.json.
"""
from __future__ import annotations

import uuid

REGULATORY_PROFILE_BY_COUNTRY = {
    "GB": "financial_services_eu",
    "DE": "financial_services_eu",
    "FR": "financial_services_eu",
    "US": "financial_services_us",
    "SG": "financial_services_apac",
    "JP": "financial_services_apac",
}


def handle_process(args: dict) -> dict:
    objective = args.get("objective") or "Unspecified task"
    task_data = args.get("task_data") or {}
    constraints_in = args.get("constraints") or {}

    country = (task_data.get("new_address") or {}).get("country") or task_data.get("country") or "GLOBAL"
    regulatory_profile = REGULATORY_PROFILE_BY_COUNTRY.get(country, "financial_services_global")

    requested_capabilities = ["identity_verification", "compliance_validation", "audit_anchoring"]
    if task_data.get("account_value") is not None:
        requested_capabilities.append("credit_risk_assessment")
    if country not in ("GLOBAL",):
        requested_capabilities.append("data_residency_check")

    # Preliminary tier - refined later by the Validation agent's composite risk score.
    account_value = float(task_data.get("account_value") or 0)
    force_violation = bool(task_data.get("force_policy_violation"))
    if force_violation:
        risk_tier = "critical"
    elif account_value >= 500_000:
        risk_tier = "high"
    elif account_value >= 100_000:
        risk_tier = "medium"
    else:
        risk_tier = "low"

    contract = {
        "contract_id": f"contract-{uuid.uuid4().hex[:12]}",
        "requester": (args.get("source_context") or {}).get("application_id") or "unknown-requester",
        "requested_capabilities": sorted(set(requested_capabilities)),
        "constraints": {
            "regulatory_profile": regulatory_profile,
            "data_residency": ",".join(constraints_in.get("data_residency") or [country]),
            "acu_budget": float(constraints_in.get("max_cost") or 5.0),
        },
        "risk_tier": risk_tier,
        # Non-schema fields kept out-of-band for downstream phases (orchestrator strips
        # these before persisting/validating the canonical contract-management document).
        "_objective": objective,
        "_task_data": task_data,
    }
    return contract


TOOL_HANDLERS = {"contract.process": handle_process}
