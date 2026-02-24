# OpenEMCP Specification

## 1. Abstract and Scope

OpenEMCP (Enterprise Multi-Agent Communication & Orchestration Protocol) defines a normative protocol for secure, compliant, and resilient multi-agent orchestration in enterprise environments.

This document is the **single source of truth for human-readable normative behavior**. Machine-readable artifacts are maintained in [spec/v1.0.0/spec.json](spec/v1.0.0/spec.json) and in [spec/v1.0.0/schemas/](spec/v1.0.0/schemas/).

OpenEMCP standardizes exactly six protocol phases, required security controls, identity constraints, and conformance expectations for implementations operating in regulated contexts.

## 2. Terminology and Glossary

### 2.1 Normative Language

The keywords **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as described in RFC 2119 and RFC 8174.

### 2.2 Core Terms

- **OpenEMCP**: The open standard protocol and governance umbrella.
- **EMCP**: Protocol shorthand used in technical fields and payload labels.
- **OASF**: Open Agent Schema Framework.
- **ACU**: Assumed Cost Unit, a normalized non-currency planning unit for comparative cost/risk estimation.
- **Context Hierarchy**: Ordered context levels: `session` → `conversation` → `agent` → `task`.
- **Negotiation**: A planning-phase sub-step where constraints (policy, SLA/SLO, residency, risk, cost) are reconciled before validation.
- **Validation**: Formal checks and approvals against policy, compliance, and risk thresholds.
- **Human-in-the-Loop (HITL)**: Mandatory human approval gate for high-impact workflows in Phase 3.

## 3. Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels.
- RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words.
- RFC 5280: Internet X.509 Public Key Infrastructure Certificate and CRL Profile.
- FINOS Project and Community Standards (governance and contribution baseline).
- EU AI Act (for human oversight and risk governance obligations).

## 3A. OASF Compliance Profile

### 3A.1 OASF Version Target

- OpenEMCP v0.1 targets **OASF major version 1.x** (minimum baseline: **1.0.0**).
- Each OpenEMCP release MUST declare its exact OASF target in release notes and conformance artifacts.

### 3A.2 Compatibility Policy

- OpenEMCP implementations MUST remain compatible with the declared OASF target version for the same release line.
- OpenEMCP MAY add extension fields, but MUST NOT change the normative meaning of mapped OASF concepts.
- Additive OpenEMCP changes SHOULD preserve backward compatibility for at least one minor release.

### 3A.3 Breaking-Change Rules

The following are treated as breaking changes and require a major-version process:

- Removing or renaming schema fields that are part of an OASF mapping.
- Narrowing allowed enum values for mapped behavior without migration path.
- Changing phase semantics such that existing OASF-aligned validation logic fails.

Breaking changes MUST include migration guidance and updated traceability evidence.

### 3A.4 OASF Conformance Outcomes

Conformance outcomes are tied to schema validation and mapping evidence:

- **pass**: all required OpenEMCP schemas validate and all mandatory OASF-mapped requirements have passing evidence.
- **conditional**: core schemas validate, but one or more non-blocking OASF-mapped requirements are pending remediation.
- **fail**: any required schema validation fails, or any mandatory OASF-mapped requirement lacks passing evidence.

### 3A.5 OASF Traceability Matrix

This matrix links protocol requirements to OASF requirement IDs, machine schema paths, and test/audit evidence.

| OpenEMCP requirement | OASF requirement ID | Schema path | Test evidence |
| --- | --- | --- | --- |
| Six standardized phase identifiers are enforced | OASF-PHASE-001 | `spec/v1.0.0/schemas/base-envelope.schema.json` | `tests/conformance/phase-enum.json` (or equivalent CI evidence) |
| Planning includes explicit negotiation sub-step | OASF-PLAN-NEG-001 | `spec/v1.0.0/schemas/planning-negotiation.schema.json` | `tests/conformance/planning-negotiation.json` |
| Validation includes mandatory HITL decision object | OASF-VAL-HITL-001 | `spec/v1.0.0/schemas/validation-compliance.schema.json` | `tests/conformance/validation-hitl.json` |
| Validation decision vocabulary is canonical (`approved`, `rejected`, `modified`) | OASF-VAL-ENUM-001 | `spec/v1.0.0/schemas/validation-compliance.schema.json`, `spec/v1.0.0/spec.json` | `tests/conformance/validation-enum.json` |
| Context hierarchy supports `session`→`conversation`→`agent`→`task` | OASF-CTX-001 | `spec/v1.0.0/schemas/context-state-management.schema.json` | `tests/conformance/context-hierarchy.json` |
| Communication payload enforces delivery status and auth-level semantics | OASF-COMM-001 | `spec/v1.0.0/schemas/communication-delivery.schema.json` | `tests/conformance/communication-delivery.json` |

`OASF requirement ID` values MUST be replaced with canonical IDs from the adopted OASF release and updated on each standards refresh.

## 4. Architecture and Phases

OpenEMCP implementations MUST expose and process the following **exact six phases**:

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
- SLA/SLO feasibility.
- ACU-based cost/risk planning thresholds.
- Data residency and cross-border constraints.

### 4.3 Phase 3: Validation & Compliance

Implementations MUST evaluate plan compliance, risk controls, and approval status before execution.

The following are REQUIRED:

- Policy validation and regulatory profile checks.
- Security authorization checks at required level.
- **Mandatory Human-in-the-Loop gate** for high-impact or regulated tasks.
- Explicit approval outcome: `approved`, `rejected`, or `modified`.

Canonical validation decision vocabulary across all artifacts (including HITL decision fields) MUST be: `approved`, `rejected`, `modified`.

### 4.4 Phase 4: Execution & Resilience

Implementations MUST support deterministic orchestration behavior with resilience controls, including failure handling, fallback routing, and compensating actions.

### 4.5 Phase 5: Context & State Management

Implementations MUST maintain hierarchical context and lineage across `session`, `conversation`, `agent`, and `task` levels.

### 4.6 Phase 6: Communication & Delivery

Implementations MUST support secure message exchange, routing integrity, and delivery traceability across agents and systems.

## 5. Data Models and Schemas

Machine-readable schema artifacts are defined in:

- [spec/v1.0.0/spec.json](spec/v1.0.0/spec.json) (protocol-level machine model)
- [spec/v1.0.0/schemas/](spec/v1.0.0/schemas/) (versioned schema set)

The human-readable normative interpretation in this document governs in case of ambiguity; schemas MUST be updated to remain aligned.

### 5.1 Schema Catalog (Mirrors spec/v1.0.0/spec.json)

The schema catalog keys and paths MUST match the `schema_catalog` object in [spec/v1.0.0/spec.json](spec/v1.0.0/spec.json):

- `version`: `v1.0.0`
- `base`: `spec/v1.0.0/schemas/base-envelope.schema.json`
- `phases.contract_management`: `spec/v1.0.0/schemas/contract-management.schema.json`
- `phases.planning_negotiation`: `spec/v1.0.0/schemas/planning-negotiation.schema.json`
- `phases.validation_compliance`: `spec/v1.0.0/schemas/validation-compliance.schema.json`
- `phases.execution_resilience`: `spec/v1.0.0/schemas/execution-resilience.schema.json`
- `phases.context_state_management`: `spec/v1.0.0/schemas/context-state-management.schema.json`
- `phases.communication_delivery`: `spec/v1.0.0/schemas/communication-delivery.schema.json`

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
2. Executes Negotiation explicitly inside Phase 2.
3. Enforces Validation & Compliance behavior including mandatory HITL gate conditions.
4. Enforces certificate TTL <= 48 hours and declared auth level controls.
5. Preserves auditable records of planning, validation, execution, and delivery outcomes.
6. Aligns machine artifacts in [spec/v1.0.0/spec.json](spec/v1.0.0/spec.json) and [spec/v1.0.0/schemas/](spec/v1.0.0/schemas/) with this document.

Conformance claims SHOULD declare supported profile(s), auth level(s), and known limitations.

## 8. Appendices

### Appendix A: Compliance Matrix

The compliance mapping (for example GDPR, DORA, EU AI Act profiles) SHOULD be maintained as versioned tables in repository documentation and linked from release notes.

### Appendix B: Threat Model

Implementations SHOULD document threats and mitigations including identity spoofing, unauthorized routing, prompt/data leakage, policy bypass, and audit tampering.

### Appendix C: Examples

Protocol examples SHOULD include at least:

- One end-to-end 6-phase flow.
- One negotiation-to-validation modification flow.
- One rejection path with HITL decision artifact.
