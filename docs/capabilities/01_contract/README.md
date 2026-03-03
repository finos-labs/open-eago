# Contract Capability Overview

Phase: 1 - Contract Management

## Purpose

The Contract capability is the protocol entry point. It accepts incoming requests, validates security/compliance context, enriches the request into OpenEMCP/OASF-aligned contract structures, and routes output to Planning.

## Canonical Reference

- Detailed specification: [contract.md](./contract.md)
- Normative protocol behavior: [../../../SPECIFICATION.md](../../../SPECIFICATION.md)
- Machine model: [../../../spec/v0.1.0/spec.json](../../../spec/v0.1.0/spec.json)
- Phase schema: [../../../spec/v0.1.0/schemas/contract-management.schema.json](../../../spec/v0.1.0/schemas/contract-management.schema.json)

## Inputs and Outputs

- **Input**: Structured API request or natural-language request with source/auth context and constraints.
- **Output**: Enriched contract payload for Phase 2 (Planning & Negotiation), with task analysis and trace metadata.

## Responsibilities (Summary)

1. Accept request payloads in supported formats.
2. Validate required contract and security metadata.
3. Classify task type and workflow intent.
4. Enrich request into protocol-compliant contract artifacts.
5. Forward contract artifacts to Planning.

## Notes

Algorithms, playbook logic, and end-to-end examples are maintained only in [contract.md](./contract.md) to avoid duplication.
