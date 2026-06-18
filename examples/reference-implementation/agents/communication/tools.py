"""Phase 6 - Communication & Delivery business logic.

Generates the customer-facing outcome message and delivery record
(spec/v0.1.0/schemas/communication-delivery.schema.json).
"""
from __future__ import annotations

import uuid


def handle_deliver(args: dict) -> dict:
    recipient = args.get("recipient") or "unknown@example.com"
    outcome_status = args.get("outcome_status") or "completed"
    audit_ref = args.get("audit_ref")

    # The message was successfully handed to the channel regardless of whether
    # the underlying request was approved or rejected - delivery_status reflects
    # transport outcome, not business outcome.
    delivery_status = "delivered"

    return {
        "message_id": f"msg-{uuid.uuid4().hex[:12]}",
        "sender": "eago-communication-agent",
        "recipient": recipient,
        "method": "email",
        "delivery_status": delivery_status,
        "security": {"mtls": False, "auth_level": 2},
        **({"audit_ref": audit_ref} if audit_ref else {}),
        "_outcome_status": outcome_status,
    }


TOOL_HANDLERS = {"communication.deliver": handle_deliver}
