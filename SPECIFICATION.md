# OpenEAGO Specification

## 1. Abstract and Scope

OpenEAGO (Enterprise Multi-Agent Communication & Orchestration Specification) defines a normative specification for secure, compliant, and resilient multi-agent orchestration in enterprise environments.

This document is the **single source of truth for human-readable normative behavior**. Machine-readable artifacts are maintained in [spec/v0.1.0/spec.json](spec/v0.1.0/spec.json) and in [spec/v0.1.0/schemas/](spec/v0.1.0/schemas/).

OpenEAGO standardizes exactly six specification phases, required security controls, identity constraints, and conformance expectations for implementations operating in regulated contexts.

## 2. Terminology and Glossary

### 2.1 Normative Language

The keywords **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described in RFC 2119 and RFC 8174.

### 2.2 Core Terms

- **OpenEAGO**: The open standard specification and governance umbrella.
- **EAGO**: Specification shorthand used in technical fields and payload labels.
- **OASF**: Open Agent Schema Framework.
- **ACU**: Assumed Cost Unit, a normalized non-currency planning unit for comparative cost/risk estimation.
- **Context Hierarchy**: Ordered context levels: `session` → `conversation` → `agent` → `task`.
- **Negotiation**: A planning-phase sub-step where constraints (policy, SLA/SLO, residency, risk, cost) are reconciled before validation.
- **Validation**: Formal checks and approvals against policy, compliance, and risk thresholds.
- **Human-in-the-Loop (HITL)**: Mandatory human approval gate for high-impact workflows in Phase 3.
- **SLA** (Service Level Agreement): A contractual performance commitment agreed between an agent provider and consumer during Phase 2 Negotiation. See [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md).
- **SLO** (Service Level Objective): An internal specification target for a specific measurable property at a defined percentile, operationalizing an SLA. SLOs MUST cover latency, availability, throughput, and error rate.
- **SLI** (Service Level Indicator): The raw measured value of a specific property, compared against SLO targets at runtime.
- **Risk Tier**: A classification (`low`, `medium`, `high`, `critical`) derived from the composite risk score computed in Phase 3. See [docs/overview/risk-management.md](docs/overview/risk-management.md).
- **Composite Risk Score**: A weighted score `∈ [0.0, 1.0]` aggregating four risk dimensions (financial, operational, compliance, security) assessed during Phase 3.
- **Circuit Breaker**: A resilience control in Phase 4 that halts execution when two or more runtime risk indicators simultaneously breach their thresholds.
- **KPI** (Key Performance Indicator): A specification-level metric that implementations MUST track and expose. The normative KPI catalog is defined in [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md).

## 3. Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels.
- RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- RFC 5280: Internet X.509 Public Key Infrastructure Certificate and CRL Profile.
- FINOS Project and Community Standards (governance and contribution baseline).
- EU AI Act (for human oversight and risk governance obligations).
- SR 11-7 (Federal Reserve — Model Risk Management): For model validation and ongoing monitoring obligations, mapped to Phase 3 risk assessment and Phase 4 runtime monitoring.
- DORA (Digital Operational Resilience Act, EU 2022/2554): For ICT risk management and operational resilience requirements, mapped to Phase 4 circuit breaker and compensating transactions.
- BCBS 239 (Principles for Effective Risk Data Aggregation and Risk Reporting): For risk data accuracy and lineage requirements, mapped to Phase 5 persistence and Phase 6 blockchain-anchored reporting.
- NIST AI RMF (AI Risk Management Framework): Govern/Map/Measure/Manage functions mapped to the cross-phase risk lifecycle defined in [docs/overview/risk-management.md](docs/overview/risk-management.md).

## 3A. OASF Compliance Profile

### 3A.1 OASF Version Target

- OpenEAGO v0.1 targets **OASF major version 1.x** (minimum baseline: **0.1.0**).
- Each OpenEAGO release MUST declare its exact OASF target in release notes and conformance artifacts.

### 3A.2 Compatibility Policy

- OpenEAGO implementations MUST remain compatible with the declared OASF target version for the same release line.
- OpenEAGO MAY add extension fields, but MUST NOT change the normative meaning of mapped OASF concepts.
- Additive OpenEAGO changes SHOULD preserve backward compatibility for at least one minor release.

### 3A.3 Breaking-Change Rules

The following are treated as breaking changes and require a major-version process:

- Removing or renaming schema fields that are part of an OASF mapping.
- Narrowing allowed enum values for mapped behavior without migration path.
- Changing phase semantics such that existing OASF-aligned validation logic fails.

Breaking changes MUST include migration guidance and updated traceability evidence.

### 3A.4 OASF Conformance Outcomes

Conformance outcomes are tied to schema validation and mapping evidence:

- **pass**: all required OpenEAGO schemas validate and all mandatory OASF-mapped requirements have passing evidence.
- **conditional**: core schemas validate, but one or more non-blocking OASF-mapped requirements are pending remediation.
- **fail**: any required schema validation fails, or any mandatory OASF-mapped requirement lacks passing evidence.

### 3A.5 OASF Traceability Matrix

This matrix links specification requirements to OASF requirement IDs, machine schema paths, and test/audit evidence.

| OpenEAGO requirement | OASF requirement ID | Schema path | Test evidence |
| --- | --- | --- | --- |
| Six standardized phase identifiers are enforced | OASF-PHASE-001 | `spec/v0.1.0/schemas/base-envelope.schema.json` | `tests/conformance/phase-enum.json` (or equivalent CI evidence) |
| Planning includes explicit negotiation sub-step | OASF-PLAN-NEG-001 | `spec/v0.1.0/schemas/planning-negotiation.schema.json` | `tests/conformance/planning-negotiation.json` |
| Validation includes mandatory HITL decision object | OASF-VAL-HITL-001 | `spec/v0.1.0/schemas/validation-compliance.schema.json` | `tests/conformance/validation-hitl.json` |
| Validation decision vocabulary is canonical (`approved`, `rejected`, `modified`) | OASF-VAL-ENUM-001 | `spec/v0.1.0/schemas/validation-compliance.schema.json`, `spec/v0.1.0/spec.json` | `tests/conformance/validation-enum.json` |
| Context hierarchy supports `session`→`conversation`→`agent`→`task` | OASF-CTX-001 | `spec/v0.1.0/schemas/context-state-management.schema.json` | `tests/conformance/context-hierarchy.json` |
| Communication payload enforces delivery status and auth-level semantics | OASF-COMM-001 | `spec/v0.1.0/schemas/communication-delivery.schema.json` | `tests/conformance/communication-delivery.json` |

`OASF requirement ID` values MUST be replaced with canonical IDs from the adopted OASF release and updated on each standards refresh.

## 4. Architecture and Phases

OpenEAGO implementations MUST expose and process the following **exact six phases**:

1. **Contract Management**
2. **Planning & Negotiation**
3. **Validation & Compliance**
4. **Execution & Resilience**
5. **Context & State Management**
6. **Communication & Delivery**

### 4.1 Phase 1: Contract Management

Implementations MUST validate request integrity, classify intended capabilities, and produce a traceable contract artifact.

### 4.2 Phase 2: Planning & Negotiation

Implementations MUST construct an execution plan and perform explicit **Negotiation** as a sub-step before Phase 3.

Required negotiation checks include:

- Capability fit and agent selection.
- Policy and regulatory constraints.
- SLA/SLO feasibility (see below).
- ACU-based cost/risk planning thresholds.
- Data residency and cross-border constraints.
- Initial financial risk score against ACU budget.

**SLA/SLO Feasibility Check (REQUIRED)**:
Implementations MUST verify all four SLO objective types — latency (`p99_ms`), availability (`availability_pct`), throughput (`throughput_rps`), and error rate (`error_rate_max`) — for every agent selected in the execution plan. The check MUST use the canonical `sla_guarantees` structure defined in [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md). A negotiation result MUST record `checks` including `"sla_slo"`. If no agent meeting all four SLO requirements is available, the execution plan MUST NOT be forwarded to Phase 3; negotiation MUST return `status: "rejected"` with reason `"sla_slo_infeasible"`.

Implementations MUST NOT select an agent with `reliability_score < 0.95` or `availability_pct < 0.9900` for any execution plan, regardless of cost or capability score. See Appendix D for the full SLA/SLO conformance requirements.

### 4.3 Phase 3: Validation & Compliance

Implementations MUST evaluate plan compliance, risk controls, and approval status before execution.

The following are REQUIRED:

- Policy validation and regulatory profile checks.
- Security authorization checks at required level.
- **Mandatory Human-in-the-Loop gate** for high-impact or regulated tasks.
- Explicit approval outcome: `approved`, `rejected`, or `modified`.
- **Composite risk score computation** across all four risk dimensions.
- **Risk tier determination** and enforcement of escalation rules.

Canonical validation decision vocabulary across all artifacts (including HITL decision fields) MUST be: `approved`, `rejected`, `modified`.

**Normative Risk Assessment Requirements**:
Implementations MUST compute a `composite_risk_score ∈ [0.0, 1.0]` using the four-dimension weighted model defined in [docs/overview/risk-management.md](docs/overview/risk-management.md). The following rules are REQUIRED:

- Implementations MUST NOT proceed to Phase 4 if `composite_risk_score ≥ 0.80` (tier: `critical`) unless an explicit override is provided containing a `board_approval_ref` or `legal_review_ref`.
- Implementations MUST trigger the HITL gate if `composite_risk_score ≥ 0.60` (tier: `high`). HITL approval is REQUIRED before Phase 4 begins.
- Implementations MUST include `risk_tier`, `composite_risk_score`, and all four dimension scores in the validation decision output.
- Implementations MUST NOT reduce the `compliance_risk` dimension weight below `0.25`.

See Appendix E for the full risk management conformance requirements.

### 4.4 Phase 4: Execution & Resilience

Implementations MUST support deterministic orchestration behavior with resilience controls, including failure handling, fallback routing, and compensating actions.

**Normative Resilience Requirements**:

- Implementations MUST implement a **circuit breaker** that activates when two or more runtime risk indicators simultaneously breach their thresholds. See Appendix E.
- Implementations MUST implement **exponential-backoff retry** for transient agent failures before activating fallback routing.
- Implementations MUST implement the **SLA breach state machine** defined in [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md), including all state transition requirements and event emission.
- Implementations MUST monitor and emit events for the following runtime risk indicators: `agent_failure_rate`, `cost_overrun_ratio`, `sla_breach_indicator`, `anomaly_score`. Threshold definitions are in Appendix E.
- Implementations MUST include `sla_compliance_status` (with `breach_state` and per-SLO status) in execution result outputs. See Appendix D.
- Implementations MUST emit all specification-level KPIs defined in [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md) via the declared observability stack (OpenTelemetry + Prometheus).

### 4.5 Phase 5: Context & State Management

Implementations MUST maintain hierarchical context and lineage across `session`, `conversation`, `agent`, and `task` levels.

### 4.6 Phase 6: Communication & Delivery

Implementations MUST support secure message exchange, routing integrity, and delivery traceability across agents and systems.

## 5. Data Models and Schemas

Machine-readable schema artifacts are defined in:

- [spec/v0.1.0/spec.json](spec/v0.1.0/spec.json) (specification-level machine model)
- [spec/v0.1.0/schemas/](spec/v0.1.0/schemas/) (versioned schema set)

The human-readable normative interpretation in this document governs in case of ambiguity; schemas MUST be updated to remain aligned.

### 5.1 Schema Catalog (Mirrors spec/v0.1.0/spec.json)

The schema catalog keys and paths MUST match the `schema_catalog` object in [spec/v0.1.0/spec.json](spec/v0.1.0/spec.json):

- `version`: `v0.1.0`
- `base`: `spec/v0.1.0/schemas/base-envelope.schema.json`
- `phases.contract_management`: `spec/v0.1.0/schemas/contract-management.schema.json`
- `phases.planning_negotiation`: `spec/v0.1.0/schemas/planning-negotiation.schema.json`
- `phases.validation_compliance`: `spec/v0.1.0/schemas/validation-compliance.schema.json`
- `phases.execution_resilience`: `spec/v0.1.0/schemas/execution-resilience.schema.json`
- `phases.context_state_management`: `spec/v0.1.0/schemas/context-state-management.schema.json`
- `phases.communication_delivery`: `spec/v0.1.0/schemas/communication-delivery.schema.json`

## 6. Security and Identity

### 6.1 Certificate and Identity Requirements

- Workload and agent certificates MUST be X.509-based.
- Certificate validity (TTL) MUST NOT exceed **48 hours**.
- Implementations MUST support certificate rotation and revocation handling.
- Mutual TLS (mTLS) MUST be enforced for inter-agent transport in regulated profiles.

### 6.2 Authentication and Authorization Matrix

| Level | Authentication | Authorization | Typical Use |
| --- | --- | --- | --- |
| 1 | API key or equivalent baseline | Role-based baseline checks | Internal low-risk development |
| 2 | OAuth2/OIDC | RBAC with scoped tokens | Standard enterprise production |
| 3 | mTLS + OAuth2/OIDC | RBAC + ABAC policy evaluation | Regulated/high-risk workflows |
| 4 | mTLS + hardware-backed or equivalent strong identity | RBAC + ABAC + explicit dual-control/HITL enforcement | Critical and safety-sensitive workflows |

Implementations claiming higher conformance levels MUST satisfy all lower levels.

## 7. Conformance Requirements

An implementation is conformant only if it:

1. Implements all six phases with required semantics.
2. Executes Negotiation explicitly inside Phase 2, including the mandatory four-dimension SLA/SLO feasibility check.
3. Enforces Validation & Compliance behavior including mandatory HITL gate conditions and the normative composite risk score thresholds.
4. Enforces certificate TTL <= 48 hours and declared auth level controls.
5. Preserves auditable records of planning, validation, execution, and delivery outcomes.
6. Aligns machine artifacts in [spec/v0.1.0/spec.json](spec/v0.1.0/spec.json) and [spec/v0.1.0/schemas/](spec/v0.1.0/schemas/) with this document.
7. Implements the SLA breach state machine, circuit breaker, and runtime risk indicator monitoring defined in Appendices D and E.
8. Emits all specification-level KPIs defined in [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md) via OpenTelemetry and Prometheus.
9. Propagates `risk_context` across all six phase transition payloads.

Conformance claims SHOULD declare supported profile(s), auth level(s), and known limitations.

Conformance claims for regulated profiles (financial services) MUST additionally declare:

- The organizational risk dimension weights applied (if deviating from defaults).
- The SLA/SLO targets declared for each registered agent type.
- The audit retention period applied for `risk_context` data.

## 8. Appendices

### Appendix A: Compliance Matrix

The compliance mapping (for example GDPR, DORA, EU AI Act profiles) SHOULD be maintained as versioned tables in repository documentation and linked from release notes.

### Appendix B: Threat Model

Implementations SHOULD document threats and mitigations including identity spoofing, unauthorized routing, prompt/data leakage, policy bypass, and audit tampering.

### Appendix C: Examples

Specification examples SHOULD include at least:

- One end-to-end 6-phase flow.
- One negotiation-to-validation modification flow.
- One rejection path with HITL decision artifact.
- One SLA breach and fallback flow.
- One `critical` risk tier automatic rejection path.

### Appendix D: SLA/SLO Conformance Requirements

This appendix defines normative SLA/SLO conformance requirements. The full design is in [docs/overview/performance-sla-slo-kpi.md](docs/overview/performance-sla-slo-kpi.md).

**D.1 Agent Registry Minimum Performance Bar**:

All registered agents MUST meet:

| Property | Minimum Value |
| --- | --- |
| `reliability_score` (rolling 7d) | ≥ 0.95 |
| `availability_pct` (rolling 30d) | ≥ 0.9900 |
| `error_rate` (rolling 7d) | ≤ 0.05 |
| `latency_p99_ms` (rolling 7d) | ≤ declared SLO × 1.20 |

Agents that drop below these thresholds MUST be marked `degraded` or `suspended` in the registry. Planning agents MUST NOT select a `degraded` agent for high-impact workflows and MUST NOT select a `suspended` agent for any workflow.

**D.2 SLA Breach State Machine**:

Implementations MUST implement the SLA breach state machine with the following states: `active`, `at_risk`, `breached`, `pause_and_review`, `fallback_activated`, `escalated`, `completed`, `terminated`. Breach events MUST be emitted to the audit trail within **5 seconds** of detection.

**D.3 SLA Compliance Status in Execution Output**:

Execution result outputs MUST include a `sla_compliance_status` object with:

- `breach_state`: current state in the SLA breach state machine.
- `overall_sla_status`: `"met"` if all SLOs remained in `active` or `completed` state throughout execution; `"breached"` otherwise.
- Per-SLO observed values and met/breached status.

**D.4 Specification-Level KPI Emission**:

Implementations MUST expose the following KPI categories via OpenTelemetry and Prometheus:

- **Reliability**: `phase_success_rate`, `workflow_e2e_success_rate`, `agent_uptime`, `circuit_breaker_trip_rate`, `fallback_activation_rate`.
- **Performance**: `phase_latency_p99_ms`, `phase_latency_p95_ms`, `agent_queue_depth`, `validation_latency_ms`.
- **Compliance**: `policy_pass_rate`, `hitl_intervention_rate`, `hitl_response_time_hours`, `risk_prediction_accuracy`, `sla_compliance_rate`, `audit_completeness_rate`.
- **Financial**: `acu_budget_adherence_rate`, `cost_overrun_rate`.
- **Security**: `auth_failure_rate`, `certificate_rotation_compliance_rate`, `policy_override_rate`.

### Appendix E: Risk Management Conformance Requirements

This appendix defines normative risk management conformance requirements. The full design is in [docs/overview/risk-management.md](docs/overview/risk-management.md).

**E.1 Risk Taxonomy and Default Weights**:

Implementations MUST use the four-dimension taxonomy: `financial_risk`, `operational_risk`, `compliance_risk`, `security_risk`.

Default weights: `financial_risk: 0.25`, `operational_risk: 0.20`, `compliance_risk: 0.30`, `security_risk: 0.25`. Implementations MAY vary weights but MUST NOT reduce `compliance_risk` below `0.25`.

**E.2 Risk Tier Thresholds (Normative)**:

| Tier | `composite_risk_score` | Required Action |
| --- | --- | --- |
| `low` | 0.00 – 0.39 | Proceed; standard monitoring |
| `medium` | 0.40 – 0.59 | Proceed; enhanced monitoring SHOULD be activated |
| `high` | 0.60 – 0.79 | MUST trigger HITL gate; MUST NOT proceed to Phase 4 without human approval |
| `critical` | 0.80 – 1.00 | MUST automatically reject; requires `board_approval_ref` or `legal_review_ref` for any override |

**E.3 Runtime Risk Indicator Thresholds**:

Implementations MUST monitor these indicators during Phase 4 and emit a `risk_event` when any threshold is breached:

| Indicator | Threshold | Risk Dimension |
| --- | --- | --- |
| `agent_failure_rate` | > 0.05 | Operational |
| `cost_overrun_ratio` | > 1.20 × approved budget | Financial |
| `sla_breach_indicator` | State machine enters `breached` | Operational |
| `anomaly_score` | > 0.70 | Security |

**E.4 Circuit Breaker Requirement**:

Implementations MUST implement a circuit breaker that trips when **two or more** runtime risk indicators simultaneously breach their thresholds. On activation, implementations MUST: (1) pause execution, (2) emit a `circuit_breaker_trip` event to the audit trail, and (3) escalate to the HITL.

**E.5 Risk Context Propagation**:

Implementations MUST include a `risk_context` object in all phase transition payloads containing at minimum: `composite_risk_score`, `risk_tier`, `dimension_scores`, `escalation_outcome`, and `risk_events` (populated from Phase 4 onwards).

**E.6 Audit Retention**:

In regulated financial profiles, `risk_context` data and all `risk_event` records MUST be retained for a minimum of **7 years** and MUST be anchored to the blockchain audit trail in Phase 6.
