"""OpenEAGO envelope parsing, validation, and response wrapping helpers."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from agent.config import CANONICAL_PHASES


class EnvelopeValidationError(ValueError):
    """Raised when an inbound OpenEAGO envelope does not satisfy contract checks."""


def _parse_iso8601(timestamp: Any) -> None:
    if not isinstance(timestamp, str) or not timestamp:
        raise EnvelopeValidationError("envelope field 'timestamp' must be a non-empty ISO-8601 string")
    try:
        datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError as e:
        raise EnvelopeValidationError("envelope field 'timestamp' must be valid ISO-8601") from e


def unwrap_envelope(body: Any) -> tuple[dict | list, dict[str, Any]]:
    """Validate and unwrap an OpenEAGO envelope.

    Returns:
      payload: JSON-RPC request object or batch array
      context: envelope fields used by response wrapper
    """
    if not isinstance(body, dict):
        raise EnvelopeValidationError("request body must be an envelope object")

    required = ("message_id", "phase", "timestamp", "payload")
    for field in required:
        if field not in body:
            raise EnvelopeValidationError(f"missing required envelope field '{field}'")

    message_id = body.get("message_id")
    if not isinstance(message_id, str) or not message_id.strip():
        raise EnvelopeValidationError("envelope field 'message_id' must be a non-empty string")

    phase = body.get("phase")
    if not isinstance(phase, str) or phase not in CANONICAL_PHASES:
        raise EnvelopeValidationError(
            "envelope field 'phase' must be a canonical OpenEAGO phase"
        )

    _parse_iso8601(body.get("timestamp"))

    payload = body.get("payload")
    if not isinstance(payload, (dict, list)):
        raise EnvelopeValidationError(
            "envelope field 'payload' must be a JSON-RPC object or JSON-RPC array"
        )

    context = {
        "message_id": message_id,
        "phase": phase,
    }
    return payload, context


def wrap_envelope(
    payload: dict | list,
    *,
    phase: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Wrap an MCP JSON-RPC payload in an OpenEAGO envelope."""
    if phase not in CANONICAL_PHASES:
        raise EnvelopeValidationError("response phase must be a canonical OpenEAGO phase")
    if not isinstance(payload, (dict, list)):
        raise EnvelopeValidationError("response payload must be a JSON object or array")

    out: dict[str, Any] = {
        "message_id": f"msg-{uuid4()}",
        "phase": phase,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": payload,
    }
    if correlation_id:
        out["correlation_id"] = correlation_id
    return out


def envelope_validation_error_body(message: str) -> dict[str, Any]:
    return {"error": {"code": "invalid_envelope", "message": message}}
