# RFC: OpenEAGO - Agent Template

**Version:** 0.1.0  
**Last Updated:** 2026-03-20  
**Authors:** OpenEAGO Team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [Target Users and Personas](#4-target-users-and-personas)
5. [Architecture Overview](#5-architecture-overview)
6. [Functional Requirements](#6-functional-requirements)
7. [Protocol and API Surface](#7-protocol-and-api-surface)
8. [Data and Configuration Model](#8-data-and-configuration-model)
9. [Security Requirements](#9-security-requirements)
10. [Non-Functional Requirements](#10-non-functional-requirements)
11. [Roadmap and Known Gaps](#11-roadmap-and-known-gaps)
12. [Acceptance Criteria](#12-acceptance-criteria)
13. [Constraints and Dependencies](#13-constraints-and-dependencies)
14. [Glossary](#14-glossary)
15. [References](#15-references)

---

## 1. Executive Summary

**OpenEAGO Agent Template** is a reference blueprint for building MCP-compatible RPC agents that also support OpenEAGO conventions for phase alignment, envelope metadata, workload identity, reliability scoring, risk propagation, and recommended Agent-Registry integration.

The template is configuration-driven (`config.yaml` + `agent.mcp.json`) so teams can quickly stand up multiple agent roles without changing core runtime code. It preserves standard MCP interoperability while layering optional OpenEAGO conventions for enterprise coordination and auditability.

This RFC defines product goals, technical requirements, security posture, and acceptance criteria for evolving the template from a working reference into a production-ready starter foundation with identity-first, reliability-aware, and risk-aware behavior.

---

## 2. Problem Statement

Teams building OpenEAGO-aligned agents face repeated implementation overhead:

| Challenge | Impact |
| --- | --- |
| Every team re-implements MCP server scaffolding | Slower delivery and inconsistent behavior |
| No shared way to express phase compatibility | Orchestrators cannot route phase-specific tasks reliably |
| Optional envelope/risk context patterns vary by project | Audit and compliance trails become fragmented |
| Agent identity handling differs per implementation | Trust boundaries are unclear and impersonation risk increases |
| Reliability score semantics are inconsistent | Orchestrators cannot compare agents fairly for routing decisions |
| Registry integration logic is duplicated | Higher maintenance cost and increased defects |
| Security setup (SPIRE/mTLS) is complex | Teams fall back to insecure defaults in development and sometimes production |

A reusable template reduces this fragmentation and provides a consistent baseline for protocol behavior, metadata shape, and security integration.

---

## 3. Goals and Non-Goals

### Goals

- **G1** - Provide a reusable, configuration-first skeleton for MCP JSON-RPC agents.
- **G2** - Preserve MCP compatibility (`tools/list`, `tools/call`, optional resources/prompts).
- **G3** - Add OpenEAGO metadata alignment (phases, capabilities, spec version).
- **G4** - Support optional OpenEAGO base-envelope wrapping without changing MCP method names.
- **G5** - Support SPIRE-based workload identity and mTLS with explicit caller identity validation.
- **G6** - Standardize reliability score fields and semantics for routing/readiness decisions.
- **G7** - Standardize risk context propagation across headers/envelope metadata.
- **G8** - Document implementation patterns that can be ported across languages.
- **G9** - Provide a runnable demo implementation validating the template contracts.

### Non-Goals

- **NG1** - Implementing all OpenEAGO orchestration logic inside a single template.
- **NG2** - Providing a full production orchestrator, scheduler, or policy engine.
- **NG3** - Mandating one runtime language for all agent implementations.
- **NG4** - Acting as a long-term persistent registry store.

---

## 4. Target Users and Personas

### Persona A: Agent Developer

> *"I need to stand up a new phase-aware agent quickly without reinventing MCP and metadata wiring."*

- Uses `config.yaml` and `agent.mcp.json` as scaffolding.
- Extends tools and business logic while keeping protocol behavior standardized.
- Benefits from built-in examples for envelope, phase headers, and registration.

### Persona B: Platform Engineer

> *"I need a repeatable deployment pattern with mTLS and registration that teams can adopt consistently."*

- Configures SPIRE cert paths and bootstrap URLs.
- Validates consistent startup behavior across services.
- Uses template defaults to reduce operational variance.

### Persona C: Security / Compliance Engineer

> *"I need proof that agents can propagate phase and risk context with auditable message metadata."*

- Verifies envelope and header conventions.
- Confirms mTLS mode and certificate trust requirements.
- Ensures metadata includes jurisdiction/compliance tags where needed.

---

## 5. Architecture Overview

### 5.1 High-Level View

```text
┌─────────────────────────────────────────────────────────────┐
│                OpenEAGO Agent Template                      │
│                                                             │
│  config.yaml        agent.mcp.json         runtime server   │
│  - server/mcp       - tools schema         - JSON-RPC       │
│  - metadata         - open_eago block      - optional mTLS  │
│  - agent details    - phase declarations   - optional reg   │
└───────────────┬───────────────────────┬─────────────────────┘
                │                       │
                ▼                       ▼
        MCP-compatible clients      OpenEAGO orchestrators
        (standard protocol)         (phase + envelope aware)
```

### 5.2 Components

| Component | Responsibility |
| --- | --- |
| `config.yaml` | Runtime and identity configuration (server, metadata, mcp, spire, bootstrap, agent details) |
| `agent.mcp.json` | MCP server/tool declaration with `open_eago` metadata conventions |
| Runtime implementation (`demo_agent.py`) | Handles transport, JSON-RPC methods, optional mTLS, and optional registry registration |
| OpenEAGO Registry (optional external) | Service discovery and metadata catalog |

### 5.3 Key Flows

1. **Startup Flow**: load config -> expose MCP endpoint -> advertise tools -> optionally register with bootstrap registry.
2. **Request Flow**: receive MCP call -> validate method and input -> run tool -> return MCP response (optionally wrapped with envelope semantics).
3. **Security Flow**: if SPIRE material exists, serve HTTPS with client-certificate validation; otherwise support controlled insecure dev mode.

---

## 6. Functional Requirements

### FR-1: Configuration and Bootstrap

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-1.1 | Template MUST load runtime settings from YAML config | P0 |
| FR-1.2 | Template MUST expose defaults and allow override by runtime flags where implemented | P1 |
| FR-1.3 | Template SHOULD validate required metadata fields (`name`, `version`, `spec_version`, phases) | P1 |
| FR-1.4 | Template SHOULD validate identity and risk config fields when enabled (`spire.*`, risk headers, trust domain) | P1 |

### FR-2: MCP Compatibility

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-2.1 | Runtime MUST support `tools/list` | P0 |
| FR-2.2 | Runtime MUST support `tools/call` for declared tools | P0 |
| FR-2.3 | Unknown methods MUST return valid JSON-RPC errors | P0 |
| FR-2.4 | Template SHOULD allow optional resources/prompts support | P2 |

### FR-3: OpenEAGO Conventions

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-3.1 | Template MUST support `open_eago` metadata conventions in MCP spec | P0 |
| FR-3.2 | `metadata.eago_phases` MUST align with canonical OpenEAGO phase enum | P0 |
| FR-3.3 | Runtime SHOULD support optional envelope mode (`mcp.eago_envelope`) | P1 |
| FR-3.4 | Runtime SHOULD support optional phase and risk context propagation headers | P1 |
| FR-3.5 | Runtime SHOULD propagate structured risk context (`risk_level`, `risk_reasons`, `risk_source`, `risk_score`) across request chains | P1 |

### FR-4: Registry Integration (Optional)

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-4.1 | Runtime MAY self-register with OpenEAGO registry on startup | P1 |
| FR-4.2 | Runtime SHOULD periodically refresh registration based on `bootstrap.sync_interval` | P1 |
| FR-4.3 | Registration payload SHOULD mirror agent registry `agent_details` shape | P1 |
| FR-4.4 | Registration payload SHOULD include reliability metrics (`reliability`, `uptime_percentage`, `health_status`) for scheduling decisions | P1 |

### FR-5: Security and Transport

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-5.1 | Runtime MUST support HTTPS with client cert verification when SPIRE is enabled | P0 |
| FR-5.2 | Runtime MUST allow controlled insecure fallback only for development | P1 |
| FR-5.3 | Security mode and certificate paths MUST be configurable | P0 |
| FR-5.4 | Runtime MUST surface authenticated caller workload identity (SPIFFE ID) to authorization and audit layers | P0 |
| FR-5.5 | Runtime SHOULD support SPIFFE trust-domain allowlisting for sensitive endpoints | P1 |

### FR-6: Reliability and Risk Signals

| ID | Requirement | Priority |
| --- | --- | --- |
| FR-6.1 | Template MUST define reliability score range as `0.0..1.0` where `1.0` is best | P0 |
| FR-6.2 | Template SHOULD define a default reliability threshold for task admission (for example `>= 0.80`) | P1 |
| FR-6.3 | Runtime SHOULD expose risk context and reliability values in health/metrics outputs when configured | P1 |
| FR-6.4 | Runtime SHOULD avoid accepting elevated-risk requests without explicit policy override in config | P2 |

---

## 7. Protocol and API Surface

### 7.1 MCP Endpoint

- **Endpoint:** `POST /mcp` (transport-specific path in demo implementation)
- **Protocol:** JSON-RPC 2.0
- **Required methods:** `tools/list`, `tools/call`
- **Optional methods:** `resources/*`, `prompts/*`

### 7.2 Supporting Endpoints (Demo Runtime)

| Endpoint | Purpose |
| --- | --- |
| `GET /` or `GET /.well-known/agent` | Agent card / discoverability |
| `GET /health` | Liveness/readiness state |
| `GET /metrics` | Basic runtime counters and health summary |
| `POST /api/execute` | OpenEMCP-style state execution demo endpoint |

### 7.3 OpenEAGO Convention Surface

Additive metadata in `agent.mcp.json`:

```json
{
  "open_eago": {
    "spec_version": "0.1.0",
    "eago_phases": [
      "contract_management",
      "planning_negotiation"
    ],
    "base_envelope": {
      "enabled": true
    }
  }
}
```

MCP clients that do not understand this block remain fully functional.

---

## 8. Data and Configuration Model

### 8.1 Top-Level Configuration

| Section | Purpose |
| --- | --- |
| `server` | Host, port, and transport mode |
| `metadata` | OpenEAGO-aligned agent identity and phase/capability declarations |
| `agent` | Registry-oriented instance metadata and operational profile |
| `mcp` | Protocol behavior and optional envelope/header controls |
| `spire` | Certificate and bundle configuration for mTLS |
| `bootstrap` | Registry URLs and sync cadence |
| `risk` | Optional risk policy (`enabled`, thresholds, allowed levels, override behavior) |

### 8.2 Required Phase Enum

`metadata.eago_phases` MUST use canonical values:

- `contract_management`
- `planning_negotiation`
- `validation_compliance`
- `execution_resilience`
- `context_state_management`
- `communication_delivery`

### 8.3 Registry Metadata Shape

The `agent` section SHOULD align with the agent-registry `agent_details` contract, including:

- `instance_id`
- `capability_codes`
- `version`
- `jurisdiction`
- `compliance`
- `reliability`
- `health_status`
- `uptime_percentage`
- `endpoints`
- optional location/resource/tag/dependency fields

### 8.4 Identity, Reliability, and Risk Fields

Recommended operational fields:

| Domain | Field | Type | Notes |
| --- | --- | --- | --- |
| Identity | `spiffe_id` | string | Workload identity URI (for example `spiffe://example.org/agent-x`) |
| Identity | `trust_domain` | string | SPIFFE trust domain used for validation and allowlisting |
| Reliability | `reliability` | float | Normalized score in range `0.0..1.0` |
| Reliability | `uptime_percentage` | float | Historical uptime in range `0.0..100.0` |
| Reliability | `health_status` | enum | `healthy`, `degraded`, `unhealthy`, `unknown` |
| Risk | `risk_level` | enum | `low`, `medium`, `high`, `critical` |
| Risk | `risk_score` | float | Optional normalized or policy-specific risk score |
| Risk | `risk_reasons` | string[] | Human/audit-readable contributors to current risk |
| Risk | `risk_source` | string | Producer of risk signal (orchestrator, policy engine, local model) |

---

## 9. Security Requirements

| Requirement | Description |
| --- | --- |
| SR-1 | Template MUST support mTLS mode with cert/key/bundle paths from config |
| SR-2 | mTLS mode MUST validate client certificates using configured trust bundle |
| SR-3 | Insecure fallback MUST be explicitly enabled (not silent auto-downgrade in production) |
| SR-4 | Runtime SHOULD avoid logging secrets or private key material |
| SR-5 | Registry registration over HTTPS SHOULD use the same trust model as the runtime server |
| SR-6 | Runtime SHOULD bind authorization rules to authenticated workload identity (SPIFFE ID), not only network location |
| SR-7 | Risk context entering from headers or envelope metadata MUST be validated and sanitized before use |
| SR-8 | High-risk requests SHOULD be policy-gated and logged with reason codes for auditability |

---

## 10. Non-Functional Requirements

### 10.1 Performance

| NFR | Target |
| --- | --- |
| NFR-P1 | `tools/list` median latency < 20 ms in local environment |
| NFR-P2 | `tools/call` dispatch overhead < 10 ms excluding tool business logic |

### 10.2 Reliability

| NFR | Target |
| --- | --- |
| NFR-R1 | Demo runtime uptime target: 99% in development environments |
| NFR-R2 | Runtime SHOULD survive temporary registry outages without terminating MCP service |
| NFR-R3 | Reliability score updates SHOULD converge in registry view within one sync interval |
| NFR-R4 | Identity verification failures SHOULD be observable with clear error classification |

### 10.3 Operability

| NFR | Target |
| --- | --- |
| NFR-O1 | One-command local startup with documented prerequisites |
| NFR-O2 | Clear startup logs indicating transport, security mode, and registration status |
| NFR-O3 | Config fields and defaults MUST be documented in README |

---

## 11. Roadmap and Known Gaps

### v0.1 - Current Template Baseline

- MCP tool listing and invocation in demo runtime
- Config and MCP spec examples
- Optional SPIRE mTLS support
- Optional registry registration loop

### v0.2 - Hardening

- Strong config validation and schema checks
- Better JSON-RPC error typing and edge-case coverage
- Safer defaults around insecure mode
- Expanded test fixtures and conformance tests

### v0.3 - Interoperability Expansion

- Optional resources/prompts parity
- Multi-transport compliance tests (stdio, SSE, streamable HTTP)
- Standardized metadata conventions for tool-level EAGO hints

### Known Gaps

- Template is reference-focused, not fully production-hardened.
- Conformance testing across multiple MCP client implementations is incomplete.
- Security posture depends on deployment discipline (especially insecure mode usage).

---

## 11.1 Implementation Plan: Registry Integration Gaps

The following items are missing from `demo_agent.py` relative to what the agent-registry already supports. Each item is self-contained and can be implemented independently.

---

### Item 1: Push live reliability and health into re-registration

**Problem:** `build_agent_details()` reads `reliability` and `health_status` from the static config dict. `AgentRuntime` already computes live values but they are never fed back.

**What to change in `demo_agent.py`:**

- Add `runtime: AgentRuntime | None = None` parameter to `build_agent_details()`.
- When `runtime` is provided, override `reliability` and `health_status` from `runtime.reliability()` and `runtime.uptime_percentage()` before returning the dict.
- Pass `MCPHandler.runtime` into `build_agent_details()` calls inside `register_with_registry()`.

**Registry side:** no change needed. `POST /register` already accepts and stores these fields; `update_registry()` preserves them on re-registration so `PUT /status` must be used to update them — covered by Item 2.

---

### Item 2: Add `PUT /status` status-update loop

**Problem:** The registry intentionally ignores `reliability`, `health_status`, and `uptime_percentage` sent via `POST /register` after the first registration (see `update_registry()` in `registry.rs` lines 26–31). The only way to update these fields in the registry is `PUT /status`.

**What to add in `demo_agent.py`:**

Add a new function `push_status_to_registry(config, address, runtime)`:

```python
def push_status_to_registry(config, address, runtime):
    # POST /status body: {"address": ..., "reliability": ..., "health_status": ..., "uptime_percentage": ...}
    # Same mTLS/insecure logic as register_with_registry()
    # Call PUT <base>/status for each bootstrap URL
```

In `sync_loop()`, call `push_status_to_registry()` on every tick alongside `register_with_registry()`, or introduce a separate, more frequent status interval (for example every 10s vs re-register every 30s).

**Config addition** in `config.example.yaml` and `DEFAULTS`:

```yaml
bootstrap:
  urls: []
  sync_interval: 30
  status_interval: 10   # new: how often to push live reliability/health
```

---

### Item 3: Graceful deregistration on shutdown (`DELETE /register/{address}`)

**Problem:** On `SIGTERM`/`SIGINT` the agent just calls `server.shutdown()`. The registry only removes it after TTL quarantine (~60–300s). This causes stale entries and delays for orchestrators.

**What to change in `demo_agent.py`:**

Add a new function `deregister_from_registry(config, address)`:

```python
def deregister_from_registry(config, address):
    # Call DELETE <base>/register/<url-encoded address> for each bootstrap URL
    # Same mTLS/insecure logic as register_with_registry()
```

In `main()`, replace the bare `except KeyboardInterrupt: pass` block:

```python
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    stop.set()                              # stop sync thread
    deregister_from_registry(config, address)
    runtime.stop()
    server.shutdown()
```

Also register a `signal.signal(signal.SIGTERM, ...)` handler so containerized deployments get clean shutdown.

---

### Item 4: Quarantine-aware health status

**Problem:** The registry transitions stale agents through `quarantine` → removal. If the agent is quarantined but still running (for example network partition), re-registration restores it — this already works. But the agent has no visibility into its own quarantine state.

**What to add in `demo_agent.py`:**

After each `register_with_registry()` call, inspect the response body. If any entry in `known_addresses` for this agent's own address has `health_status: "quarantine"`, log a warning:

```python
# Parse response JSON
# If own address appears with health_status == "quarantine": warn and trigger immediate re-registration
```

This is low-priority but provides operational observability.

---

### Item 5: `uptime_percentage` — use live value, not `null`

**Problem:** `config.example.yaml` and `config.yaml` both have `uptime_percentage: null`. The registry stores `None`. The live value is computed in `AgentRuntime.uptime_percentage()` but never written back.

**What to change:**

This is automatically resolved by Item 1 (pass `runtime` into `build_agent_details()`) and Item 2 (`PUT /status` carries `uptime_percentage`). No separate code change needed beyond those two items.

---

### Summary table

| Item | Change location | Effort | Dependency |
| --- | --- | --- | --- |
| 1 – Live metrics in re-registration | `build_agent_details()`, `register_with_registry()` | Small | None |
| 2 – `PUT /status` loop | New `push_status_to_registry()`, `sync_loop()`, config | Small–Medium | Item 1 for values |
| 3 – Graceful deregister on shutdown | New `deregister_from_registry()`, `main()` shutdown block, signal handler | Small | None |
| 4 – Quarantine-aware logging | `register_with_registry()` response parsing | Small | None |
| 5 – Live `uptime_percentage` | Resolved by Items 1 and 2 | None | Items 1 + 2 |

---

## 12. Acceptance Criteria

### AC-1: MCP baseline interoperability

```gherkin
Given an agent started from the template
When a client sends tools/list to the MCP endpoint
Then the agent returns valid JSON-RPC with at least one tool definition
```

### AC-2: Tool invocation works end-to-end

```gherkin
Given an advertised tool exists
When a client sends tools/call with valid arguments
Then the agent returns a valid JSON-RPC result payload
```

### AC-3: Phase metadata compliance

```gherkin
Given metadata.eago_phases in config
When configuration is loaded
Then each phase value matches the canonical OpenEAGO enum
```

### AC-4: mTLS enforcement in secure mode

```gherkin
Given SPIRE mode is enabled with valid cert material
When a client connects without an accepted certificate
Then the TLS handshake is rejected
```

### AC-5: Optional registry integration

```gherkin
Given bootstrap.urls are configured and registry is reachable
When the template runtime starts
Then the agent registers and appears in registry list results
```

### AC-6: Identity-aware access

```gherkin
Given SPIRE mode is enabled and trust allowlist is configured
When a caller from a non-allowed SPIFFE identity invokes a protected endpoint
Then the request is rejected and an authorization audit event is emitted
```

### AC-7: Reliability score compliance

```gherkin
Given agent reliability is configured and reported
When the runtime publishes registration or health metadata
Then reliability is in range 0.0 to 1.0 and uptime_percentage is in range 0.0 to 100.0
```

### AC-8: Risk context propagation

```gherkin
Given a request contains risk context metadata
When the runtime processes and forwards the request
Then risk context is preserved in configured header/envelope fields
And invalid risk fields are rejected or sanitized per policy
```

---

## 13. Constraints and Dependencies

| Dependency | Purpose | Notes |
| --- | --- | --- |
| MCP protocol (JSON-RPC 2.0 patterns) | Core agent tool interface | Must remain wire-compatible |
| OpenEAGO specification | Phase and envelope semantics | Canonical enum and schema references |
| SPIRE (optional) | Workload identity and mTLS cert lifecycle | Required for secure mode |
| OpenEAGO agent-registry (optional) | Discovery and registration | Used when bootstrap integration is enabled |

Runtime behavior is intentionally template-grade and should be hardened per deployment requirements.

---

## 14. Glossary

| Term | Definition |
| --- | --- |
| **Agent Template** | Starter structure for building OpenEAGO-aligned MCP agents |
| **MCP** | Model Context Protocol for tool/resource/prompt interactions |
| **OpenEAGO Phase** | One of six lifecycle categories used for orchestration context |
| **Base Envelope** | Optional OpenEAGO message wrapper carrying metadata and payload |
| **Reliability Score** | Normalized agent quality indicator in range `0.0..1.0` used for routing decisions |
| **Risk Context** | Structured metadata describing request or operation risk, including level, score, and reasons |
| **SPIFFE ID** | URI-based workload identity asserted via X.509 SVID |
| **SPIRE** | SPIFFE runtime providing workload identities and certificate issuance |
| **Bootstrap Registry** | Registry endpoint used by agents for self-registration and discovery |

---

## 15. References

- [OpenEAGO SPECIFICATION](../../SPECIFICATION.md)
- [OpenEAGO Spec Catalog](../../spec/v0.1.0/spec.json)
- [Base Envelope Schema](../../spec/v0.1.0/schemas/base-envelope.schema.json)
- [Agent Registry RFC](../agent-registry/RFC.md)
- [Agent Template README](./README.md)
- [Model Context Protocol](https://modelcontextprotocol.io/)

