# Validation Capability Overview

Phase: 3 - Validation & Compliance

## Purpose

The Validation capability evaluates plans against policy, risk, compliance, and approval requirements before execution is allowed.

## Canonical Reference

- Detailed specification: [validation.md](./validation.md)
- Normative protocol behavior: [../../../SPECIFICATION.md](../../../SPECIFICATION.md)
- Machine model: [../../../spec/v1.0.0/spec.json](../../../spec/v1.0.0/spec.json)
- Phase schema: [../../../spec/v1.0.0/schemas/validation-compliance.schema.json](../../../spec/v1.0.0/schemas/validation-compliance.schema.json)

## Inputs and Outputs

- **Input**: Execution plan artifacts from Phase 2.
- **Output**: Validation decision (`approved`, `rejected`, `modified`) and execution conditions for Phase 4.

## Responsibilities (Summary)

1. Evaluate policy and regulatory conformance.
2. Assess risk and budget thresholds.
3. Apply approval workflow and HITL gates where required.
4. Produce explicit decision artifacts with audit traceability.
5. Forward approved/modified artifacts to Execution.

## Notes

Decision algorithms, escalation examples, and detailed payloads are maintained only in [validation.md](./validation.md) to avoid duplication.
