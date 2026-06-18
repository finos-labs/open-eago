# RFC: OpenEAGO Reference Implementation

**Version:** 0.1.0
**Status:** Reference implementation / demo - not for production use
**Authors:** OpenEAGO Team

## 1. Executive Summary

This example wires together OpenEAGO's existing reference components (`examples/agent-template`, `examples/agent-registry`) into a runnable, end-to-end demonstration of the six-phase specification, with a real-time dashboard. It exists to answer one question concretely: **does the spec actually work, phase to phase, with real agent discovery and real schema-validated payloads?**

## 2. Problem Statement

Before this example, the repo had the building blocks for OpenEAGO (a spec, JSON schemas, conformance fixtures, an agent template, a registry) but no runnable proof that six independently-discoverable agents could be driven through the full Contract -> Planning -> Validation -> Execution -> Context -> Communication pipeline with conformant payloads at every step, including the spec's governance machinery (composite risk scoring, the mandatory HITL gate, the SLA breach state machine). Reviewers and implementers had to read the spec's worked examples on paper rather than watch them execute.

## 3. Goals and Non-Goals

### Goals

- **G1** - Demonstrate all six phases end-to-end using real agent processes discovered via the real registry, not in-process stubs.
- **G2** - Validate every phase artifact against the actual `spec/v0.1.0/schemas/*.json` files at runtime, not just in a separate test suite.
- **G3** - Make the mandatory HITL gate, composite risk scoring, and SLA breach state machine interactively observable, not just log lines.
- **G4** - Push every state transition to a UI in real time (WebSocket), not via polling.
- **G5** - Reuse `agent-template` and `agent-registry` as-is or with minimal, justified extension rather than duplicating their logic.

### Non-Goals

- **NG1** - Production security (mTLS/SPIRE is supported by the underlying components but disabled here for setup simplicity).
- **NG2** - High availability, multi-instance agents, or load balancing across same-capability agents.
- **NG3** - Full OASF/agntcy.org schema alignment beyond what `contract-management.schema.json` already requires.
- **NG4** - Authentication on the orchestrator's own REST/WebSocket surface.

## 4. Architecture

See `README.md` for the full diagram and run instructions. In short: `agent-registry` (unmodified) for discovery; six processes built on a vendored, lightly-extended copy of `agent-template`'s runtime (`agents/_lib/`) for the phase logic; a new FastAPI + LangGraph orchestrator for pipeline control, schema validation, Mongo persistence, and WebSocket broadcast; a new React/Vite/Tailwind dashboard for visualization and HITL interaction.

### 4.1 Extensions to `agent-template` (vendored copy, not the original example)

| Change | Why |
| --- | --- |
| `build_tools_from_spec(..., extra_handlers=...)` | The template only hard-codes `eago_health`; phase agents need real business-logic tools. |
| `wrap_envelope(..., spec_version=...)` | `base-envelope.schema.json` requires `spec_version`; the template's envelope didn't yet emit it. |

Both changes are additive and backward compatible with the original template's behavior.

### 4.2 The HITL gate

Per `validation-compliance.schema.json`, every validation document carries a `hitl` object with `required: true` (const) and a `decision`. Low/medium risk is auto-decided immediately (an automated rubber-stamp); high/critical risk pauses the LangGraph run (`compiled_full` graph routes to `END` while `status=awaiting_hitl`) until `POST /api/v1/executions/{id}/hitl-decision` is called, which resumes via a second compiled graph (`compiled_resume`) sharing the same node functions - no logic duplication between the paused and golden-path routes.

## 5. Known Gaps / Backlog

| ID | Gap | Notes |
| --- | --- | --- |
| GAP-1 | Single Mongo collection, no replica set | Fine for a demo; not a durability story |
| GAP-2 | No mTLS between orchestrator and agents | `agent-template`/`agent-registry` support it; disabled here for setup simplicity |
| GAP-3 | Registry's reliability/uptime floor (spec §4.2: 0.95 / 99.0%) means a freshly restarted agent is invisible to `/discover` for ~90-100s | Documented in README; correct registry behavior, not a defect |
| GAP-4 | Only one hierarchy level (`session`) emitted by the Context phase | The spec's full `session -> conversation -> agent -> task` hierarchy would need multiple context records per execution |
| GAP-5 | No load balancing across multiple instances of the same phase agent | `planning_negotiation`'s discovery takes the first result from `/discover`; genjinni's random-selection load balancing was not reproduced |

## 6. Relationship to other examples

This is a Track 1 (core spec implementation) example per `examples/README.md`. It is the conformance target the same way `agent-template` and `agent-registry` are: artifacts it persists should pass the same JSON Schema checks as `tests/run_conformance.py`. See `scripts/smoke_test_agents.py` for a runnable demonstration of this against live agent output.
