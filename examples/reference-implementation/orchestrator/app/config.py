"""Orchestrator configuration (env-overridable)."""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SCHEMAS_DIR = REPO_ROOT / "spec" / "v0.1.0" / "schemas"

REGISTRY_URL = os.environ.get("EAGO_REGISTRY_URL", "http://127.0.0.1:8443")
MONGODB_URI = os.environ.get(
    "EAGO_MONGODB_URI", "mongodb://admin:password@127.0.0.1:27017/?authSource=admin"
)
MONGODB_DATABASE = os.environ.get("EAGO_MONGODB_DATABASE", "eago_reference_implementation")

SPEC_VERSION = "0.1.0"

PHASE_SCHEMAS = {
    "contract_management": "contract-management.schema.json",
    "planning_negotiation": "planning-negotiation.schema.json",
    "validation_compliance": "validation-compliance.schema.json",
    "execution_resilience": "execution-resilience.schema.json",
    "context_state_management": "context-state-management.schema.json",
    "communication_delivery": "communication-delivery.schema.json",
}
