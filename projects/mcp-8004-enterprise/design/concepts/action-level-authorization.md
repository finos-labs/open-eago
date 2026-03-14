# Design: Action-Level Authorization

> **Concept 10** — Preventing destructive agent actions through structural enforcement
>
> **Status:** Implemented
>
> **Depends on:** Concept 1 (Hybrid Orchestration), Concept 2 (Distributed Tracing), Concept 3 (Flow Authorization), Concept 4 (Reputation Gating), Concept 7 (Dynamic Autonomy Bounding), Concept 8 (Flow Anomaly Detection)

---

## Problem Statement

All nine existing concepts govern whether an agent *may participate* in a flow and whether its outputs meet quality and structural thresholds. None of them govern **what specific operations an agent may perform on external systems** once authorized. An authorized AML agent with `aml_review` capability and sufficient reputation can invoke any tool available to it — including tools that write to a sanctions database, provision client accounts, or execute a legal contract — because the governance stack authorizes *participation*, not *actions*.

Natural language instructions embedded in prompts ("you must never delete backups") are not a security boundary. They are advisory. An LLM can hallucinate, be prompt-injected, misinterpret context, or simply ignore instructions. The gap is structural: between the moment an agent decides to invoke a tool and the moment that invocation reaches an external system, there is no typed, classified, permit-checked enforcement layer.

This is the same class of gap that Concept 5 closed for prompts and Concept 6 closed for datasets: a critical input to the execution chain that was invisible to the governance stack.

---

## Design

### 10.1 Action Classification

Every tool invocation that reaches an external system is classified into one of four tiers:

| Tier | Name | Examples | Enforcement |
|------|------|----------|-------------|
| 0 | Read-only | query KYC status, read client profile, `GET /aml/status`, list documents | Permitted by default if agent holds flow authorization for the capability |
| 1 | Reversible write | submit AML screening recommendation, issue contract draft, propose credit terms | Permitted per explicit role-level action permit |
| 2 | Irreversible / destructive | execute legal contract, accept credit facility, provision client account | Requires multi-agent approval or human-in-the-loop confirmation before execution |
| 3 | Forbidden | delete audit log entries, purge execution trace, mass client data export | Never executable by any agent regardless of role; hard block, no override |

Tier assignment is by **action pattern**, not by intent. The runtime gateway classifies based on the parsed command, not on the agent's stated reason for issuing it.

### 10.2 On-Chain: `ActionPermitRegistry`

A new contract following the same patterns as `FlowAuthorizationRegistry` and `DatasetRegistry`.

#### Structs

```solidity
struct ActionPermit {
    uint256 agentId;
    bytes32 flowId;          // traceId of the flow
    bytes32 actionType;      // keccak256 of the canonical action pattern, e.g., keccak256("SQL:DROP")
    uint8   tier;            // 0–3
    bool    approved;        // resolved approval state
    uint256 approvalCount;   // for Tier 2 multi-sig: how many approvers have signed
    uint256 requiredApprovals; // for Tier 2: threshold
}
```

```solidity
struct ActionPattern {
    bytes32 patternHash;     // keccak256 of the pattern string
    uint8   tier;            // default tier for this pattern
    bool    registered;      // exists in the global catalogue
}
```

#### Key Functions

| Function | Description |
|----------|-------------|
| `registerPattern(bytes32 patternHash, uint8 tier)` | Owner registers a known action pattern with its default tier. Tier 3 patterns are globally forbidden. |
| `grantPermit(bytes32 flowId, uint256 agentId, bytes32 actionType, uint8 tier, uint256 requiredApprovals)` | Flow initiator grants an agent permission to perform a specific action type within a flow. Reverts if `tier == 3`. |
| `approveAction(bytes32 flowId, uint256 agentId, bytes32 actionType)` | An approver (another agent or human address) adds their approval to a Tier 2 permit. When `approvalCount >= requiredApprovals`, `approved` becomes `true`. |
| `validateAction(bytes32 flowId, uint256 agentId, bytes32 actionType) → bool` | Called by oracle contracts and the runtime gateway. Returns `true` only if a valid, approved permit exists. Tier 0 returns `true` if the agent holds flow authorization. Tier 3 always returns `false`. |
| `revokePermit(bytes32 flowId, uint256 agentId, bytes32 actionType)` | Flow initiator or owner revokes a previously granted permit. |

#### Events

```solidity
event ActionPatternRegistered(bytes32 indexed patternHash, uint8 tier);
event ActionPermitGranted(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, uint8 tier);
event ActionPermitApproved(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, address approver);
event ActionPermitResolved(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, bool approved);
event ActionPermitRevoked(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType);
event ActionBlocked(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, uint8 tier);
```

#### Storage Efficiency

Permits are keyed by `keccak256(abi.encodePacked(flowId, agentId, actionType))` in a single `mapping(bytes32 => ActionPermit)`. Action patterns use `mapping(bytes32 => ActionPattern)`. No dynamic arrays in hot-path lookups. `validateAction` performs at most three `SLOAD` operations (pattern lookup, permit lookup, flow authorization fallback for Tier 0).

### 10.3 Off-Chain: Runtime Action Gateway

The runtime gateway sits between the agent's tool invocation and the external system. It is implemented as a middleware layer in the existing bridge TypeScript code.

#### Action Classification Engine

A pattern registry loaded at startup from a configuration file (`action-patterns.json`) and from the MCP spec's new `action_permits` block. Patterns are regular expressions or structured matchers:

```json
{
  "patterns": [
    { "id": "AML:QUERY",       "regex": "aml:(query|check|lookup)",  "tier": 0 },
    { "id": "AML:SCREEN",      "regex": "aml:screen_client",         "tier": 1 },
    { "id": "CREDIT:PROPOSE",  "regex": "credit:propose_terms",      "tier": 1 },
    { "id": "CREDIT:ACCEPT",   "regex": "credit:accept_terms",       "tier": 2 },
    { "id": "LEGAL:DRAFT",     "regex": "legal:issue_.*draft",       "tier": 1 },
    { "id": "LEGAL:EXECUTE",   "regex": "legal:execute_contract",    "tier": 2 },
    { "id": "SETUP:PROVISION", "regex": "setup:(account|products)",  "tier": 2 },
    { "id": "AUDIT:DELETE",    "regex": "audit:(delete|purge)",      "tier": 3 }
  ]
}
```

The engine parses the raw command string from the tool invocation, matches it against patterns in priority order (highest tier wins on conflict), and returns the `actionType` hash and tier.

#### Gateway Flow

```
Agent LLM → tool invocation intent
    │
    ▼
┌──────────────────────────────┐
│  1. Parse & classify action  │  ← action-patterns.json + MCP spec
│  2. Compute actionType hash  │
│  3. Check tier               │
│     ├─ Tier 3 → HARD BLOCK  │  → emit ActionBlocked event, violation signal
│     ├─ Tier 2 → check chain │  → approveAction multi-sig, pause if pending
│     ├─ Tier 1 → check chain │  → validateAction must return true
│     └─ Tier 0 → check flow  │  → flow authorization sufficient
│  4. If approved → execute    │
│  5. Record action in trace   │
└──────────────────────────────┘
    │
    ▼
External System (DB, shell, API)
```

**Critical invariant:** the agent never directly accesses external systems. Every tool invocation routes through this gateway. This is enforced architecturally: tool implementations in the MCP server call the gateway, not the external system directly.

### 10.4 MCP Spec Extension: `action_permits` Block

Following the pattern established by Concept 7 (`autonomy_bounds`) and Concept 8 (`flow` signal block), the MCP spec gains an optional `action_permits` block per tool:

```json
{
  "name": "execute_contract",
  "description": "Execute the bilaterally approved legal agreement",
  "inputSchema": { "type": "object", "properties": { "request_id": { "type": "string" }, "final_hash": { "type": "string" } } },
  "action_permits": {
    "classification": "legal",
    "tool_action": "legal:execute_contract",
    "default_tier": 2,
    "approval_timeout_seconds": 600,
    "violation_threshold": 2
  }
}
```

`sync-autonomy-bounds.js` is extended to read `action_permits` blocks and call `registerPattern` and `grantPermit` on `ActionPermitRegistry` during deployment.

### 10.5 Signal Integration

Action-level authorization emits signals that integrate with the existing Concept 7 dynamic autonomy bounding and Concept 8 anomaly detection:

| Signal Type | Trigger | Effect |
|-------------|---------|--------|
| **Violation** | Agent attempts a Tier 3 action or a Tier 1/2 action without a permit | Reputation score reduction via `ReputationRegistryUpgradeable`. If score drops below threshold, `ReputationGate` blocks further capability use. |
| **Escalation** | Tier 2 action pending multi-agent or human approval | `bounds-monitor.js` emits an escalation event. The flow is paused for the specific tool invocation (not the entire flow). Other tools remain operational. |
| **Anomaly** | Agent issues an unusual volume of action requests, or repeatedly attempts forbidden actions | Feeds into the existing burst detection in `bounds-monitor.js`. Repeated violations trigger `disableTool()` via `AutonomyBoundsRegistry`. |

Violation signals are recorded on-chain via the `ActionBlocked` event, which includes the `flowId`, `agentId`, `actionType`, and `tier`. This is auditable alongside all other governance events.

### 10.6 Oracle Integration

Oracle contracts gain `ActionPermitRegistry` as the tenth authorization check, following the same opt-in pattern as all previous layers:

```solidity
address public actionPermitRegistry;

function _validateAction(
    bytes32 traceId,
    uint256 agentId,
    bytes32 actionType
) internal view {
    if (actionPermitRegistry != address(0)) {
        require(
            IActionPermitRegistry(actionPermitRegistry).validateAction(traceId, agentId, actionType),
            "action not permitted"
        );
    }
}
```

Setting `actionPermitRegistry` to `address(0)` disables the layer with no gas overhead beyond a single `ISZERO` check, consistent with all other opt-in layers.

### 10.7 Human-in-the-Loop for Tier 2

Tier 2 actions require explicit approval before execution. The approval mechanism supports two modes:

**Multi-agent approval:** Other agents in the flow with the `approve_action` capability can call `approveAction()` on-chain. The permit resolves when `approvalCount >= requiredApprovals`.

**Human approval:** A designated human operator address is included in the approver set. The bridge emits a webhook or notification (implementation-specific) and pauses the specific tool invocation. The human calls `approveAction()` from their wallet. The bridge polls or listens for the `ActionPermitApproved`/`ActionPermitResolved` event and resumes execution.

In both modes, the flow is not globally paused. Only the specific action invocation is held pending. The agent can continue other non-blocked tool invocations within the same flow.

A configurable timeout (from the MCP spec `action_permits.approval_timeout_seconds`, default 300) governs how long the gateway waits before treating the action as denied and emitting a timeout signal.

---

## Relationship to Existing Concepts

| Concept | Relationship |
|---------|-------------|
| **C1 (Hybrid Orchestration)** | Action permits are validated through the same oracle trust anchor |
| **C2 (Distributed Tracing)** | Action events are correlated via the same `traceId`; `ExecutionTraceLog` records the action hop |
| **C3 (Flow Authorization)** | Tier 0 actions fall back to flow authorization; action permits are scoped to the same `flowId` |
| **C4 (Reputation Gating)** | Violation signals reduce reputation scores; reputation thresholds can block agents who repeatedly violate action permits |
| **C5 (Prompt Governance)** | Orthogonal — prompts govern what the agent is told to do; action permits govern what it is allowed to do |
| **C6 (Dataset Control)** | Orthogonal — dataset governance controls inputs; action permits control outputs |
| **C7 (Dynamic Autonomy)** | Violation and anomaly signals feed into the same `bounds-monitor.js` and `AutonomyBoundsRegistry`; repeated action violations trigger `disableTool()` |
| **C8 (Flow Anomaly Detection)** | Repeated blocked actions within a flow contribute to burst detection thresholds |
| **C9 (Card Integrity)** | Orthogonal — card hash validates identity; action permits validate behavior |

---

## What It Achieves

A structural enforcement layer between agent intent and external system access. The agent runtime acts as a mandatory, typed, classified, permit-checked gateway. The LLM can reason about any action — the enforcement is structural, not conversational. Instructions in prompts remain useful as guidance for the agent's decision-making, but safety-critical boundaries are enforced by code that the agent cannot bypass, override, or hallucinate around.

The full audit trail — *who acted, in what flow, with what reputation, using what prompt, on what data, within what autonomy bounds, with what structural safeguards, with what card identity, **and what actions were permitted, attempted, blocked, or approved*** — is readable from the ledger.

