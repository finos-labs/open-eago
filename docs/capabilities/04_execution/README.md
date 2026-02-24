# Execution Capability Overview

Phase: 4 - Execution & Resilience

## Purpose

The Execution capability orchestrates approved plans at runtime, coordinates agent calls, enforces execution conditions, and emits execution outcomes with auditability.

## Canonical Reference

- Detailed specification: [execution.md](./execution.md)
- Normative protocol behavior: [../../../SPECIFICATION.md](../../../SPECIFICATION.md)
- Machine model: [../../../spec/v1.0.0/spec.json](../../../spec/v1.0.0/spec.json)
- Phase schema: [../../../spec/v1.0.0/schemas/execution-resilience.schema.json](../../../spec/v1.0.0/schemas/execution-resilience.schema.json)

## Inputs and Outputs

- **Input**: Validation decision and approved plan from Phase 3.
- **Output**: Execution result artifacts for Phase 5.

## Responsibilities (Summary)

1. Orchestrate task execution patterns.
2. Coordinate secure inter-agent communication.
3. Monitor runtime cost, latency, and policy thresholds.
4. Apply failure handling and fallback logic.
5. Produce auditable execution outputs.

## Notes

Runtime algorithms, monitoring logic, and payload examples are maintained only in [execution.md](./execution.md) to avoid duplication.
