# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""DSSE v1 envelopes signed with Ed25519, and the checks a verifier runs on them."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
from collections.abc import Mapping
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .jcs import CanonicalizationError, canonicalize

PAYLOAD_TYPE = "application/vnd.in-toto+json"
STATEMENT_TYPE = "https://in-toto.io/Statement/v1"


class VerificationError(Exception):
    """A check failed. ``code`` is a stable, machine-readable reason."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def pae(payload_type: str, payload: bytes) -> bytes:
    """DSSE v1 Pre-Authentication Encoding."""
    t = payload_type.encode("utf-8")
    return b"DSSEv1 %d %s %d %s" % (len(t), t, len(payload), payload)


def public_key_hex(key: Ed25519PrivateKey) -> str:
    return key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()


def keyid(public_hex: str) -> str:
    """A key identifier: the first 32 hex digits of SHA-256 over the raw key."""
    return hashlib.sha256(bytes.fromhex(public_hex)).hexdigest()[:32]


def sign_statement(statement: Mapping[str, Any], key: Ed25519PrivateKey) -> dict[str, Any]:
    """Wrap the JCS bytes of an in-toto Statement in a signed DSSE envelope."""
    payload = canonicalize(statement)
    signature = key.sign(pae(PAYLOAD_TYPE, payload))
    return {
        "payloadType": PAYLOAD_TYPE,
        "payload": base64.b64encode(payload).decode("ascii"),
        "signatures": [
            {"keyid": keyid(public_key_hex(key)), "sig": base64.b64encode(signature).decode("ascii")}
        ],
    }


def _b64(value: Any, what: str) -> bytes:
    if not isinstance(value, str):
        raise VerificationError("envelope-malformed", f"{what} is not a string")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VerificationError("envelope-malformed", f"{what} is not base64") from exc


def open_envelope(envelope: Any, trusted_keys: Mapping[str, str]) -> dict[str, Any]:
    """Verify a DSSE envelope and return the in-toto Statement it carries.

    ``trusted_keys`` maps a label to a raw Ed25519 public key in hex. A
    signature counts only when one of those keys verifies it over the PAE; the
    envelope's ``keyid`` is a hint and is never trusted on its own.
    """
    if not isinstance(envelope, dict) or not isinstance(envelope.get("signatures"), list):
        raise VerificationError("envelope-malformed", "not a DSSE envelope")
    if envelope.get("payloadType") != PAYLOAD_TYPE:
        raise VerificationError("payload-type-mismatch", repr(envelope.get("payloadType")))
    payload = _b64(envelope.get("payload"), "payload")
    if not envelope["signatures"]:
        raise VerificationError("no-signatures")
    message = pae(PAYLOAD_TYPE, payload)
    keys = [Ed25519PublicKey.from_public_bytes(bytes.fromhex(h)) for h in trusted_keys.values()]
    verified = False
    for entry in envelope["signatures"]:
        if not isinstance(entry, dict):
            raise VerificationError("envelope-malformed", "signature entry is not an object")
        sig = _b64(entry.get("sig"), "sig")
        for key in keys:
            try:
                key.verify(sig, message)
                verified = True
            except InvalidSignature:
                continue
    if not verified:
        raise VerificationError("signature-invalid", "no trusted key verifies any signature")
    return _statement(payload)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    names = [name for name, _ in pairs]
    if len(set(names)) != len(names):
        raise VerificationError("duplicate-member", "an object repeats a member name")
    return dict(pairs)


def _statement(payload: bytes) -> dict[str, Any]:
    try:
        statement = json.loads(payload, object_pairs_hook=_no_duplicates)
    except (UnicodeDecodeError, ValueError) as exc:
        raise VerificationError("statement-malformed", "payload is not JSON") from exc
    try:
        canonical = canonicalize(statement)
    except CanonicalizationError as exc:
        raise VerificationError("payload-not-canonical", str(exc)) from exc
    if canonical != payload:
        raise VerificationError("payload-not-canonical", "payload is not RFC 8785 bytes")
    if not isinstance(statement, dict) or statement.get("_type") != STATEMENT_TYPE:
        raise VerificationError("statement-malformed", "not an in-toto Statement v1")
    subjects = statement.get("subject")
    if not isinstance(subjects, list) or not subjects:
        raise VerificationError("statement-malformed", "subject is empty")
    for subject in subjects:
        digest = subject.get("digest") if isinstance(subject, dict) else None
        if not isinstance(digest, dict) or not digest:
            raise VerificationError("statement-malformed", "subject without digest")
    if not isinstance(statement.get("predicateType"), str):
        raise VerificationError("statement-malformed", "predicateType missing")
    return statement
