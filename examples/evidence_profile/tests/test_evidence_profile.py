# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
import base64
import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from evidence_profile import (
    VerificationError,
    canonicalize,
    demo_key,
    emit_run,
    public_key_hex,
    verify_run,
    verify_step,
)

HERE = Path(__file__).resolve().parents[1]
SCHEMAS = HERE.parents[1] / "spec" / "v0.1.0" / "schemas"
PAYLOAD_SCHEMA = {
    "contract_management": "contract-management",
    "planning_negotiation": "planning-negotiation",
    "validation_compliance": "validation-compliance",
    "execution_resilience": "execution-resilience",
    "context_state_management": "context-state-management",
    "communication_delivery": "communication-delivery",
}
KEYS = {"demo": public_key_hex(demo_key())}


@pytest.fixture(scope="module")
def run():
    return json.loads((HERE / "fixtures" / "run.json").read_text())


def _validator(name):
    schema = json.loads((SCHEMAS / f"{name}.schema.json").read_text())
    registry = Registry().with_resources(
        (json.loads(p.read_text())["$id"], Resource.from_contents(json.loads(p.read_text())))
        for p in SCHEMAS.glob("*.json")
    )
    return Draft202012Validator(schema, registry=registry, format_checker=FormatChecker())


def test_fixture_messages_are_schema_valid(run):
    assert {m["phase"] for m in run} == set(PAYLOAD_SCHEMA)
    for message in run:
        _validator("base-envelope").validate(message)
        _validator(PAYLOAD_SCHEMA[message["phase"]]).validate(message["payload"])


def test_roundtrip(run):
    envelopes = emit_run(run, demo_key())
    statements = verify_run(envelopes, run, KEYS)
    assert [s["subject"][0]["name"] for s in statements] == [m["message_id"] for m in run]
    assert statements[0]["predicate"]["previousEnvelope"] is None
    payload = base64.b64decode(envelopes[0]["payload"])
    assert payload == canonicalize(json.loads(payload))


def test_emission_is_deterministic(run):
    assert emit_run(run, demo_key()) == emit_run(run, demo_key())


def test_tampered_message_is_rejected(run):
    envelopes = emit_run(run, demo_key())
    altered = copy.deepcopy(run[2])
    altered["payload"]["risk_assessment"]["composite_risk_score"] = 0.12
    with pytest.raises(VerificationError) as err:
        verify_step(envelopes[2], altered, KEYS)
    assert err.value.code == "subject-digest-mismatch"


def test_tampered_payload_is_rejected(run):
    envelope = emit_run(run, demo_key())[0]
    statement = json.loads(base64.b64decode(envelope["payload"]))
    statement["predicate"]["phase"] = "execution_resilience"
    envelope["payload"] = base64.b64encode(canonicalize(statement)).decode()
    with pytest.raises(VerificationError) as err:
        verify_step(envelope, run[0], KEYS)
    assert err.value.code == "signature-invalid"


def test_untrusted_key_is_rejected(run):
    envelope = emit_run(run, demo_key())[0]
    with pytest.raises(VerificationError) as err:
        verify_step(envelope, run[0], {"other": public_key_hex(_other())})
    assert err.value.code == "signature-invalid"


def test_dropped_or_reordered_step_breaks_the_chain(run):
    envelopes = emit_run(run, demo_key())
    with pytest.raises(VerificationError) as err:
        verify_run(envelopes[:2] + envelopes[3:], run[:2] + run[3:], KEYS)
    assert err.value.code == "chain-broken"
    swapped = [envelopes[1], envelopes[0], *envelopes[2:]]
    with pytest.raises(VerificationError) as err:
        verify_run(swapped, [run[1], run[0], *run[2:]], KEYS)
    assert err.value.code == "chain-broken"


def test_signed_but_noncanonical_payloads_are_rejected(run):
    from evidence_profile import open_envelope, pae

    key = demo_key()
    statement = base64.b64decode(emit_run(run, key)[0]["payload"]).decode()
    for payload, code in [
        (json.dumps(json.loads(statement), indent=1), "payload-not-canonical"),
        ('{"_type":"x",' + statement[1:], "duplicate-member"),
    ]:
        raw = payload.encode()
        envelope = {
            "payloadType": "application/vnd.in-toto+json",
            "payload": base64.b64encode(raw).decode(),
            "signatures": [{"sig": base64.b64encode(key.sign(pae("application/vnd.in-toto+json", raw))).decode()}],
        }
        with pytest.raises(VerificationError) as err:
            open_envelope(envelope, KEYS)
        assert err.value.code == code


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ({"b": 1, "a": [True, None, "x"]}, b'{"a":[true,null,"x"],"b":1}'),
        ({"\u20ac": 1, "\r": 2}, '{"\\r":2,"\u20ac":1}'.encode()),
        ([1.0, 0.5, 1e21, 1e-7, 123456789012.5, -0.0], b"[1,0.5,1e+21,1e-7,123456789012.5,0]"),
    ],
)
def test_jcs(value, expected):
    assert canonicalize(value) == expected


def _other():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    return Ed25519PrivateKey.from_private_bytes(b"\x01" * 32)
