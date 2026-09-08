# OpenEAGO Conformance Suite

This directory contains the machine-runnable conformance test fixtures for OpenEAGO v0.1.0. Each file exercises one normative requirement from the [OASF Traceability Matrix](../../SPECIFICATION.md#3a5-oasf-traceability-matrix).

## Running

```bash
pip install jsonschema
python tests/run_conformance.py
```

Pass `--verbose` to see individual case results including passing cases.

## What a conformance claim means

An implementation is **conformant** only if all fixtures pass when its payloads are validated against the declared schemas. Shipping a binary that produces valid payloads is necessary but not sufficient — the implementation must also enforce the behavioral rules (HITL gate triggering, risk-tier hard stops, SLA breach state machine) that the schemas encode.

## Fixture format

Each `.json` file in this directory follows this structure:

```json
{
  "requirement_id": "OASF-XXX-001",
  "description": "What the requirement asserts",
  "schema": "spec/v0.1.0/schemas/<phase>.schema.json",
  "cases": [
    {
      "id": "unique-case-id",
      "description": "What this case verifies",
      "valid": true,
      "payload": { ... }
    }
  ]
}
```

`valid: true` means the payload MUST validate successfully against the schema.  
`valid: false` means the schema MUST reject the payload — these cases verify that constraints are enforced, not just that valid inputs are accepted.

## Requirement coverage

| File | Requirement ID | Normative rule |
| --- | --- | --- |
| `phase-enum.json` | OASF-PHASE-001 | Base envelope phase field must be one of the six canonical values; `spec_version` must be present and semver-formatted |
| `planning-negotiation.json` | OASF-PLAN-NEG-001 | Planning payload must include an explicit `negotiation` sub-object; `checks` must contain `sla_slo` |
| `validation-hitl.json` | OASF-VAL-HITL-001 | Validation payload must include a `hitl` object with `required: true` and a `decision` field |
| `validation-enum.json` | OASF-VAL-ENUM-001 | `validation_status` and `hitl.decision` must use the canonical vocabulary (`approved`, `rejected`, `modified`); `compliance_risk` weight must not fall below 0.25 |
| `context-hierarchy.json` | OASF-CTX-001 | Context `level` must be one of `session`, `conversation`, `agent`, `task`; `lineage` must be present |
| `communication-delivery.json` | OASF-COMM-001 | `delivery_status` must be canonical; `security` must be present with `auth_level` in [1, 4] |
| `validation-attestation.json` | OEAGO-VAL-ATTEST-001 | Decision-record `attestation` is optional and backward-compatible; when present, `status` is required and `referenced`/`attested` states require their supporting fields |

`OEAGO-`-prefixed requirement IDs are OpenEAGO-native requirements with no OASF-mapped equivalent, as opposed to the `OASF-`-prefixed IDs above. See [SPECIFICATION.md §3A.5](../../SPECIFICATION.md#3a5-oasf-traceability-matrix).

## Adding new fixtures

1. Create a new `.json` file following the format above.
2. Reference the schema by repo-root-relative path.
3. Include at least one positive case (valid payload) and one negative case (invalid payload that enforces a specific constraint).
4. Run `python tests/run_conformance.py` to confirm all cases behave as declared.
5. Add a row to the coverage table above.
