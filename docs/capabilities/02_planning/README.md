# Planning Capability Overview

Phase: 2 - Planning & Negotiation

## Purpose

The Planning capability transforms validated contracts into executable plans by selecting agents, applying constraints, and producing workflow orchestration artifacts for validation.

## Canonical Reference

- Detailed specification: [planning.md](./planning.md)
- Normative specification behavior: [../../../SPECIFICATION.md](../../../SPECIFICATION.md)
- Machine model: [../../../spec/v0.1.0/spec.json](../../../spec/v0.1.0/spec.json)
- Phase schema: [../../../spec/v0.1.0/schemas/planning-negotiation.schema.json](../../../spec/v0.1.0/schemas/planning-negotiation.schema.json)

## Inputs and Outputs

- **Input**: Enriched contract artifacts from Phase 1.
- **Output**: Execution plan and negotiation outcomes for Phase 3.

## Responsibilities (Summary)

1. Discover and rank candidate agents.
2. Match capabilities to requirements and constraints.
3. Build execution strategy (sequential/parallel/mixed).
4. Estimate cost, duration, and risk envelopes.
5. Produce plan artifacts for validation.

## Notes

Registry models, planning algorithms, and code examples are maintained only in [planning.md](./planning.md) to avoid duplication.
