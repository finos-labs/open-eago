# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""One signed in-toto Statement per OpenEAGO message, chained across a run.

The subject of each Statement is the message itself: its ``message_id`` as the
name and the SHA-256 of its RFC 8785 canonical bytes as the digest. A verifier
holding the message can therefore check that the envelope is about exactly
those bytes, and a verifier holding the whole run can check that no step was
dropped, reordered or replaced.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping, Sequence
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .dsse import STATEMENT_TYPE, VerificationError, open_envelope, sign_statement
from .jcs import canonicalize

PREDICATE_TYPE = "https://finos-labs.github.io/open-eago/evidence/step/v0.1"


def message_digest(message: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonicalize(message)).hexdigest()


def envelope_digest(envelope: Mapping[str, Any]) -> str:
    return hashlib.sha256(canonicalize(envelope)).hexdigest()


def build_statement(message: Mapping[str, Any], previous: str | None) -> dict[str, Any]:
    return {
        "_type": STATEMENT_TYPE,
        "subject": [{"name": message["message_id"], "digest": {"sha256": message_digest(message)}}],
        "predicateType": PREDICATE_TYPE,
        "predicate": {
            "phase": message["phase"],
            "specVersion": message["spec_version"],
            "correlationId": message.get("correlation_id"),
            "timestamp": message["timestamp"],
            "previousEnvelope": previous,
        },
    }


def emit_run(messages: Sequence[Mapping[str, Any]], key: Ed25519PrivateKey) -> list[dict[str, Any]]:
    """Sign every message of a run, each Statement naming its predecessor's envelope."""
    envelopes: list[dict[str, Any]] = []
    previous: str | None = None
    for message in messages:
        envelope = sign_statement(build_statement(message, previous), key)
        envelopes.append(envelope)
        previous = envelope_digest(envelope)
    return envelopes


def verify_step(
    envelope: Mapping[str, Any], message: Mapping[str, Any], trusted_keys: Mapping[str, str]
) -> dict[str, Any]:
    """Verify one envelope and that it binds exactly ``message``."""
    statement = open_envelope(envelope, trusted_keys)
    if statement["predicateType"] != PREDICATE_TYPE:
        raise VerificationError("predicate-type-mismatch", statement["predicateType"])
    subject = statement["subject"][0]
    if subject.get("name") != message.get("message_id"):
        raise VerificationError("subject-name-mismatch", str(subject.get("name")))
    if subject["digest"].get("sha256") != message_digest(message):
        raise VerificationError("subject-digest-mismatch", str(message.get("message_id")))
    return statement


def verify_run(
    envelopes: Sequence[Mapping[str, Any]],
    messages: Sequence[Mapping[str, Any]],
    trusted_keys: Mapping[str, str],
) -> list[dict[str, Any]]:
    """Verify every step and the chain that links them, in order."""
    if len(envelopes) != len(messages):
        raise VerificationError("run-length-mismatch", f"{len(envelopes)} != {len(messages)}")
    previous: str | None = None
    statements = []
    for envelope, message in zip(envelopes, messages):
        statement = verify_step(envelope, message, trusted_keys)
        if statement["predicate"].get("previousEnvelope") != previous:
            raise VerificationError("chain-broken", str(message.get("message_id")))
        statements.append(statement)
        previous = envelope_digest(envelope)
    return statements
