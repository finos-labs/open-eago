#!/usr/bin/env python3
# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""Build the DSSE envelope conformance suite this example's verifier is replayed on.

The signed envelopes come from the pinned ``agent-evidence-vectors`` package:
every member of its two DSSE corpora (``vectors-agent-audit-record`` and
``vectors-observed-effect``), each signed with a test key that corpus publishes.
Those corpora judge predicate semantics with their own readers; this suite asks
the envelope-layer question only, so their envelopes are accept members here,
except the few whose defect is in the signed bytes themselves (a repeated member
name, a payload that is not its RFC 8785 form), which stay rejects.
Deterministic mutations of every envelope become further reject members. The
six envelopes this example emits for ``fixtures/run.json`` are accept members
too.

    python conformance/build_suite.py <out-dir>
    agent-evidence-vectors --vectors <out-dir>/suite \
        --verifier "python3 verify_adapter.py"   # with EVIDENCE_PROFILE_KEYS set
"""

from __future__ import annotations

import base64
import hashlib
import json
import sys
from importlib import metadata, resources
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402

from evidence_profile import canonicalize, demo_key, emit_run, pae, public_key_hex  # noqa: E402

PINNED = "0.17.4"
SOURCE_CORPORA = ("vectors-agent-audit-record", "vectors-observed-effect")
PAYLOAD_TYPE = "application/vnd.in-toto+json"


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _resign(payload: bytes, key: Ed25519PrivateKey, payload_type: str = PAYLOAD_TYPE) -> dict:
    return {
        "payloadType": payload_type,
        "payload": _b64(payload),
        "signatures": [{"keyid": "", "sig": _b64(key.sign(pae(payload_type, payload)))}],
    }


def _mutations(envelope: dict, outsider: Ed25519PrivateKey) -> list[tuple[str, dict, str]]:
    payload = base64.b64decode(envelope["payload"])
    sig = bytearray(base64.b64decode(envelope["signatures"][0]["sig"]))
    sig[0] ^= 0x01
    flipped = bytearray(payload)
    flipped[len(flipped) // 2] ^= 0x01

    def variant(**changes: object) -> dict:
        return {**envelope, **changes}

    return [
        ("sig-bit-flip", variant(signatures=[{**envelope["signatures"][0], "sig": _b64(bytes(sig))}]),
         "signature-invalid"),
        ("payload-bit-flip", variant(payload=_b64(bytes(flipped))), "signature-invalid"),
        ("payload-type-swapped", variant(payloadType="application/json"), "payload-type-mismatch"),
        ("unpinned-signer", _resign(payload, outsider), "signature-invalid"),
        ("no-signatures", variant(signatures=[]), "no-signatures"),
        ("payload-not-base64", variant(payload="!" + envelope["payload"]), "envelope-malformed"),
    ]


def _envelope_layer_codes(vector: dict) -> list[str] | None:
    """The codes this profile must reach on a source member, or None if it is admitted.

    A source member the corpus calls ``malformed`` for a reason that lives in
    the signed bytes (a repeated member name, a payload that is not its RFC 8785
    form) is refused at the envelope layer too. Every other source member is a
    well-formed signed envelope whose verdict is about predicate semantics.
    """
    expected = vector.get("expected", {})
    codes = set(expected.get("codes", []))
    if expected.get("verdict") != "malformed":
        return None
    if "duplicate-member" in codes:
        return ["duplicate-member"]
    if vector.get("slug", "").endswith("not-rfc8785"):
        return ["payload-not-canonical"]
    return None


def _source_envelopes() -> tuple[list[tuple[str, dict, list[str] | None]], dict[str, str]]:
    corpora = resources.files("agent_evidence_vectors") / "corpora"
    members: list[tuple[str, dict, list[str] | None]] = []
    keys: dict[str, str] = {}
    for name in SOURCE_CORPORA:
        manifest = json.loads((corpora / name / "MANIFEST.json").read_text())
        for role, key in manifest["keys"].items():
            keys[f"{name}:{role}"] = key["publicKey"]
        for vector in manifest["vectors"]:
            envelope = json.loads((corpora / name / vector["file"]).read_text())
            members.append((f"{name}:{vector['id']}", envelope, _envelope_layer_codes(vector)))
    return members, keys


def build(out: Path) -> Path:
    version = metadata.version("agent-evidence-vectors")
    if version != PINNED:
        raise SystemExit(f"agent-evidence-vectors {version} installed, {PINNED} pinned")
    suite = out / "suite"
    (suite / "envelopes").mkdir(parents=True, exist_ok=True)
    members, keys = _source_envelopes()
    run = json.loads((ROOT / "fixtures" / "run.json").read_text())
    members += [(f"open-eago:{m['message_id']}", e, None) for m, e in zip(run, emit_run(run, demo_key()))]
    keys["open-eago:demo"] = public_key_hex(demo_key())
    outsider = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"unpinned signer").digest())

    vectors = []

    def add(kind: str, source: str, envelope: dict, expected: dict) -> None:
        vid = "v" + hashlib.sha256(canonicalize(envelope)).hexdigest()[:16]
        (suite / "envelopes" / f"{vid}.json").write_text(json.dumps(envelope, indent=2) + "\n")
        vectors.append({"id": vid, "kind": kind, "file": f"envelopes/{vid}.json",
                        "source": source, "expected": expected})

    for source, envelope, refused in members:
        if refused:
            add("reject", source, envelope, {"verdict": "invalid", "codes": refused})
        else:
            add("accept", source, envelope, {"verdict": "valid"})
        for label, mutated, code in _mutations(envelope, outsider):
            add("reject", f"{source}:{label}", mutated, {"verdict": "invalid", "codes": [code]})

    # Correctly signed by a pinned key over bytes that parse to a valid Statement
    # but are not its RFC 8785 form. A verifier that only checks signatures
    # admits it; this profile signs JCS bytes, so it requires them.
    loose = json.dumps(json.loads(base64.b64decode(members[-1][1]["payload"])), indent=1).encode()
    add("indeterminate", "open-eago:non-canonical-payload", _resign(loose, demo_key()),
        {"verdict": "invalid", "readings": {"jcs-required": "payload-not-canonical"}})

    counts: dict[str, int] = {}
    for vector in vectors:
        counts[vector["kind"]] = counts.get(vector["kind"], 0) + 1
    manifest = {
        "suite": "open-eago-evidence-profile-dsse-envelope",
        "source": {"package": "agent-evidence-vectors", "version": PINNED, "corpora": list(SOURCE_CORPORA)},
        "counts": counts,
        "vectors": vectors,
    }
    (suite / "MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (out / "keys.json").write_text(json.dumps(keys, indent=2) + "\n")
    print(f"suite {suite}: {counts}")
    return suite


if __name__ == "__main__":
    build(Path(sys.argv[1] if len(sys.argv) > 1 else "build"))
