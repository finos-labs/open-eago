"""Validate phase artifacts against spec/v0.1.0/schemas/*.

Mirrors the approach in tests/run_conformance.py so a live demo run can be
checked with the exact same conformance logic the repo's test suite uses.
"""
from __future__ import annotations

import json
from functools import lru_cache

from jsonschema import Draft202012Validator

from app.config import PHASE_SCHEMAS, SCHEMAS_DIR


def strip_internal(obj):
    """Drop leading-underscore keys agents use to pass extra context between
    phases - these are not part of the canonical schema and must not be
    persisted/validated as such."""
    if isinstance(obj, dict):
        return {k: strip_internal(v) for k, v in obj.items() if not k.startswith("_")}
    if isinstance(obj, list):
        return [strip_internal(v) for v in obj]
    return obj


@lru_cache(maxsize=None)
def _validator_for(phase: str) -> Draft202012Validator:
    schema_path = SCHEMAS_DIR / PHASE_SCHEMAS[phase]
    schema = json.loads(schema_path.read_text())
    return Draft202012Validator(schema)


def validate_phase(phase: str, doc: dict) -> tuple[bool, list[str]]:
    """Validate a phase artifact. Returns (conformant, error_messages)."""
    cleaned = strip_internal(doc)
    validator = _validator_for(phase)
    errors = [e.message for e in validator.iter_errors(cleaned)]
    return (len(errors) == 0, errors)
