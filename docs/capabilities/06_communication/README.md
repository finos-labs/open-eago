# Communication Capability Overview

Phase: 6 - Communication & Delivery

## Purpose

The Communication capability converts context and execution outcomes into delivery artifacts for users/systems across configured channels, with personalization and compliance-aware reporting.

## Canonical Reference

- Detailed specification: [communication.md](./communication.md)
- Normative protocol behavior: [../../../SPECIFICATION.md](../../../SPECIFICATION.md)
- Machine model: [../../../spec/spec.json](../../../spec/spec.json)
- Phase schema: [../../../schemas/v0.1/communication-delivery.schema.json](../../../schemas/v0.1/communication-delivery.schema.json)

## Inputs and Outputs

- **Input**: Context state artifacts from Phase 5.
- **Output**: Final communication/delivery artifacts and delivery status records.

## Responsibilities (Summary)

1. Generate response content from context and outcomes.
2. Apply channel formatting and delivery orchestration.
3. Enforce communication policy and audit requirements.
4. Track delivery outcomes and notification status.
5. Emit final response artifacts and traces.

## Notes

Response-generation logic, channel adapters, and example payloads are maintained only in [communication.md](./communication.md) to avoid duplication.
