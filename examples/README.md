# OpenEAGO Examples

This directory contains implementation examples and research explorations organized into two distinct tracks. The two tracks serve different purposes and are at different stages of maturity.

---

## Track 1 — Core Spec Implementations

These examples directly implement normative behavior defined in the [OpenEAGO Specification](../SPECIFICATION.md). They are the intended starting point for anyone building an OpenEAGO-conformant system.

| Example | Spec Phase | What it implements |
| --- | --- | --- |
| [agent-template](agent-template/) | All phases | Reference MCP agent with OpenEAGO phase alignment, SPIRE mTLS, and registry integration. Start here if you are building an agent. |
| [agent-registry](agent-registry/) | Phase 2 — Planning | Distributed agent registry over mTLS (SPIRE). Agents register capabilities and discover peers. Implements the registry component relied on during Planning & Negotiation. |
| [reference-implementation](reference-implementation/) | All phases | End-to-end demo wiring `agent-template` + `agent-registry` into a runnable six-phase pipeline (FastAPI + LangGraph orchestrator) with a real-time WebSocket dashboard — composite risk scoring, the mandatory HITL gate, and the SLA breach state machine are all interactively observable. Start here to see the spec actually run. |
| [context-management](context-management/) | Phase 5 — Context | CRDT-based concurrent state management for multi-agent workflows with auditable merge history. Implements the hierarchical context model (`session → conversation → agent → task`). |
| [provenance_manifest](provenance_manifest/) | Phase 4/6 — Execution, Communication | Cryptographically signed audit records for AI agent invocations. Produces self-verifying, ECDSA P-256 signed manifests suitable for regulatory audit. Implements the audit-anchoring requirement. |

---

## Track 2 — Research Explorations

These examples explore how OpenEAGO governance concepts can be extended into adjacent technical domains — on-chain identity, prompt governance, and alternative distributed registries. They are **R&D work**, not normative implementations of the specification. A reviewer looking for spec compliance should focus on Track 1.

| Example | Domain | What it explores |
| --- | --- | --- |
| [mcp-erc8004-enterprise](mcp-erc8004-enterprise/) | On-chain agent governance | Nine-layer authorization stack combining ERC-721 on-chain identity (ERC-8004), MCP agent invocation, and Solidity oracle contracts. Models a cross-institutional bank onboarding workflow with on-chain phase bitmask tracking. Self-described as an R&D development project. |
| [prompt_registry](prompt_registry/) | Prompt governance | Implements Layer 4 of the nine-layer stack from `mcp-erc8004-enterprise`: binds LangSmith prompt versions to on-chain keccak256 hashes, closing the gap between on-chain governance and LLM prompt integrity. |
| [sui-agent-registry](sui-agent-registry/) | SUI blockchain registry | On-chain agent registration, discovery, and reputation scoring on the SUI blockchain (Move language). Live on SUI testnet. Inspired by ERC-8004 and OpenEAGO identity concepts. |

---

## Relationship to the conformance suite

The Track 1 examples are the reference targets for the [conformance test suite](../tests/conformance/). A Track 1 implementation is expected to produce payloads that pass `python3 tests/run_conformance.py`. Track 2 examples are not conformance targets — they apply governance concepts in environments (blockchains, smart contracts) with their own validation models.

---

## Domain vocabulary

Both tracks use capability types and compliance profile identifiers. The canonical values are defined in [spec/v0.1.0/schemas/domain-vocabulary.schema.json](../spec/v0.1.0/schemas/domain-vocabulary.schema.json). Using these identifiers (e.g. `kyc_verification`, `aml_screening`, `GDPR`, `DORA`) rather than local equivalents is what makes two independent implementations semantically interoperable — not just wire-compatible.
