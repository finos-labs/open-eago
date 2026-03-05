# Context Capability Overview

Phase: 5 - Context & State Management

## Purpose

The Context capability consolidates workflow state across phases, preserves hierarchical context, and provides continuity artifacts for communication and follow-up workflows.

## Canonical Reference

- Detailed specification: [context.md](./context.md)
- Normative specification behavior: [../../../SPECIFICATION.md](../../../SPECIFICATION.md)
- Machine model: [../../../spec/v0.1.0/spec.json](../../../spec/v0.1.0/spec.json)
- Phase schema: [../../../spec/v0.1.0/schemas/context-state-management.schema.json](../../../spec/v0.1.0/schemas/context-state-management.schema.json)

## Inputs and Outputs

- **Input**: Execution result artifacts from Phase 4.
- **Output**: Context state artifacts for Phase 6.

## Responsibilities (Summary)

1. Maintain hierarchical context (session/conversation/agent/task).
2. Consolidate state updates from completed workflow phases.
3. Preserve context continuity and recovery metadata.
4. Expose context for downstream response generation.
5. Maintain lineage and traceability metadata.

## Notes

Context hierarchy models, persistence logic, and analytics examples are maintained only in [context.md](./context.md) to avoid duplication.
