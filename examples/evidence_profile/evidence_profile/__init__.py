# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""Signed, re-checkable evidence for OpenEAGO orchestration runs."""

import hashlib

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .dsse import VerificationError, open_envelope, pae, public_key_hex, sign_statement
from .jcs import canonicalize
from .profile import PREDICATE_TYPE, emit_run, verify_run, verify_step


def demo_key() -> Ed25519PrivateKey:
    """A PUBLISHED TEST key from a fixed seed. Never use it for real evidence."""
    seed = hashlib.sha256(b"open-eago evidence profile test key").digest()
    return Ed25519PrivateKey.from_private_bytes(seed)


__all__ = [
    "PREDICATE_TYPE",
    "VerificationError",
    "canonicalize",
    "demo_key",
    "emit_run",
    "open_envelope",
    "pae",
    "public_key_hex",
    "sign_statement",
    "verify_run",
    "verify_step",
]
