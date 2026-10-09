<!-- Copyright 2026 Sankalp Gilda. SPDX-License-Identifier: Apache-2.0 -->

# Evidence profile

Signed, re-checkable evidence for an OpenEAGO orchestration run. For every message in a run, this example emits one [DSSE](https://github.com/secure-systems-lab/dsse) envelope whose payload is the RFC 8785 (JCS) canonical bytes of an [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md), signed with Ed25519. The verifier checks the signature over the DSSE pre-authentication encoding, that the payload is exactly its canonical form, that the Statement's subject digest is the SHA-256 of the canonical message, and that each step names the envelope before it, so a dropped, reordered or swapped step is caught.

It fills the gap recorded in #66: none of the payload schemas carries a signature, digest or attester, so `attestation.status` can say a record was attested but not prove it. An envelope from this profile is the proof that field can point at, and it also fits the external-evidence case in #70.

| Statement field | Value |
|---|---|
| `subject[0].name` | the message's `message_id` |
| `subject[0].digest.sha256` | SHA-256 of the JCS bytes of the whole message (base envelope plus payload) |
| `predicateType` | `https://finos-labs.github.io/open-eago/evidence/step/v0.1` |
| `predicate` | `phase`, `specVersion`, `correlationId`, `timestamp`, `previousEnvelope` (SHA-256 of the previous step's JCS envelope, `null` for the first) |

## Run it

```bash
cd examples/evidence_profile
pip install -r requirements-dev.txt
python -m evidence_profile emit fixtures/run.json out
python -m evidence_profile verify fixtures/run.json out
python -m pytest
```

`fixtures/run.json` is a six-step onboarding run, one message per phase, and the tests validate each message against `spec/v0.1.0/schemas`. The signing key is a published test key from a fixed seed (`demo_key()`); never use it for real evidence.

Output of `verify`:

```
ok msg-001 sha256:490d2bc510c4847b...
ok msg-002 sha256:02c9288c35266977...
ok msg-003 sha256:d225020c3ee601fd...
ok msg-004 sha256:e6ddb1b867578e6b...
ok msg-005 sha256:5fc49326d7d5eefd...
ok msg-006 sha256:4f86fa8c57d51475...
verified 6 steps, chain intact
```

## Conformance

The envelope verifier (Python 3.13 or later for the harness) is replayed against signed DSSE envelopes from the conformance corpora in [`agent-evidence-vectors`](https://pypi.org/project/agent-evidence-vectors/), pinned by version and wheel hash in `requirements-conformance.txt`. `conformance/build_suite.py` assembles the suite from the package's two DSSE corpora plus this example's own six envelopes, adds six deterministic mutations of each envelope (flipped signature bit, flipped payload bit, swapped `payloadType`, unpinned signer, no signatures, payload that is not base64), and the package's harness drives `verify_adapter.py` over all of it:

```bash
pip install --require-hashes --no-deps -r requirements-conformance.txt
python conformance/build_suite.py build
EVIDENCE_PROFILE_KEYS=build/keys.json agent-evidence-vectors \
  --vectors build/suite --verifier "python3 verify_adapter.py"
```

```
totals: 841 vectors, 841 pass, 0 fail; report written to conformance-report.json
verifier: python3 verify_adapter.py ran on 841 of 841 vectors
```

`.github/workflows/evidence-profile.yml` runs the tests, the emit and verify round trip, and this replay on every change to the example or the schemas.
