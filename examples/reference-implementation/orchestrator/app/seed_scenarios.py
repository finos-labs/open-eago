"""Four canned demo scenarios driving the Customer Address Update golden path
(the worked example used throughout docs/capabilities/*) through distinct
governance branches, for the dashboard's Scenario Launcher panel.
"""
from __future__ import annotations

SCENARIOS: dict[str, dict] = {
    "approved": {
        "objective": "Update customer address and validate identity for regulatory compliance",
        "customer_id": "CUST-UK-789012",
        "new_address": {"country": "GB"},
        "account_value": 2000,
        "verification_documents": [{"type": "passport"}, {"type": "utility_bill"}],
    },
    "hitl_required": {
        "objective": "Update customer address for a high-value account",
        "customer_id": "CUST-BR-445566",
        "new_address": {"country": "BR"},
        "account_value": 1_000_000,
        "verification_documents": [],
        "constraints": {"max_cost": 0.5},
    },
    "blocked": {
        "objective": "Update customer address flagged by sanctions screening",
        "customer_id": "CUST-XX-990011",
        "new_address": {"country": "GB"},
        "account_value": 5000,
        "verification_documents": [{"type": "passport"}, {"type": "utility_bill"}],
        "force_policy_violation": True,
    },
    "sla_breach": {
        "objective": "Update customer address under degraded execution conditions",
        "customer_id": "CUST-GB-112233",
        "new_address": {"country": "GB"},
        "account_value": 3000,
        "verification_documents": [{"type": "passport"}, {"type": "utility_bill"}],
        "simulate_latency_ms": 5000,
    },
}
