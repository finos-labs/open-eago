# ERC-8004 MCP Spec Extensions

> **Applies to:** `agents/mcp/*.mcp.json`
> **Standard baseline:** MCP 1.0 (`$schema: https://modelcontextprotocol.io/schema/v1/server.json`)

---

## Overview

Standard MCP specs describe tools, resources, and prompts for LLM consumption. ERC-8004 augments them with governance metadata that the on-chain / off-chain toolchain reads to enforce agent safety policies.

**Design principle:** extra fields that are not part of the MCP schema are silently ignored by compliant MCP clients (Claude Desktop, MCP Inspector, etc.). The extensions exist at the per-tool level so each tool can carry its own independent policy.

Three extension blocks have been added, introduced across Concepts 7, 8, and 10 of the design:

| Block | Concept | Introduced | Consumed by |
|---|---|---|---|
| `autonomy_bounds` (reputation, anomaly, performance) | 7 | 2026-02-28 | `bounds-monitor.js`, `sync-autonomy-bounds.js` |
| `autonomy_bounds.flow` | 8 | 2026-03-02 | `bounds-monitor.js`, `sync-autonomy-bounds.js` |
| `action_permits` | 10 | 2026-03-06 | `action-gateway.js`, `bounds-monitor.js` |

---

## Extension 1 — `autonomy_bounds` (Concept 7)

**Location:** each tool object, alongside `inputSchema` and `outputSchema`.

```json
"autonomy_bounds": {
  "reputation": {
    "signal": "reputation_degradation",
    "min_score": 30,
    "min_score_decimals": 0,
    "min_feedback_count": 5,
    "tag": "review_code",
    "action": "revoke"
  },
  "anomaly": {
    "signal": "anomaly_detection",
    "max_error_rate_pct": 20,
    "window_requests": 50,
    "action": "revoke"
  },
  "performance": {
    "signal": "performance_degradation",
    "min_success_rate_pct": 80,
    "window_requests": 100,
    "action": "revoke"
  }
}
```

### Signal blocks

#### `reputation` — on-chain threshold gate

| Field | Type | Description |
|---|---|---|
| `signal` | `"reputation_degradation"` | Identifies this as the reputation signal block |
| `min_score` | integer | Minimum acceptable average reputation score |
| `min_score_decimals` | integer | Decimal precision of `min_score` |
| `min_feedback_count` | integer | Minimum number of feedback entries before the gate activates |
| `tag` | string | Capability tag used to filter `ReputationRegistry` entries |
| `action` | `"revoke"` | Action taken when the threshold is violated |

Consumed by `sync-autonomy-bounds.js` to call `ReputationGate.setThreshold(capability, minScore, scoreDecimals, minCount, tag)` on deployment.

#### `anomaly` — off-chain sliding window

| Field | Type | Description |
|---|---|---|
| `signal` | `"anomaly_detection"` | Identifies this as the anomaly detection block |
| `max_error_rate_pct` | integer | Maximum acceptable error rate percentage over `window_requests` |
| `window_requests` | integer | Rolling window size in number of requests |
| `action` | `"revoke"` | Action taken: calls `AutonomyBoundsRegistry.disableTool()` |

Tracked by `bounds-monitor.js` per agent. When the window ratio exceeds `max_error_rate_pct`, the monitor calls `disableTool()`.

#### `performance` — off-chain sliding window

| Field | Type | Description |
|---|---|---|
| `signal` | `"performance_degradation"` | Identifies this as the performance signal block |
| `min_success_rate_pct` | integer | Minimum acceptable success rate percentage over `window_requests` |
| `window_requests` | integer | Rolling window size in number of requests |
| `action` | `"revoke"` | Action taken when threshold is violated |

Same monitoring mechanism as `anomaly`, using the complement metric (success rate instead of error rate).

---

## Extension 2 — `autonomy_bounds.flow` (Concept 8)

**Location:** nested inside the `autonomy_bounds` block.

```json
"autonomy_bounds": {
  ...,
  "flow": {
    "signal": "flow_anomaly",
    "max_hops": 20,
    "loop_detection": true,
    "max_requests_per_minute": 10,
    "response_timeout_seconds": 300,
    "action": "revoke"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `signal` | `"flow_anomaly"` | Identifies this as the flow anomaly block |
| `max_hops` | integer | Maximum hops allowed per `traceId` in `ExecutionTraceLog`; passed to `setMaxHops()` |
| `loop_detection` | boolean | Whether to enable loop detection in `ExecutionTraceLog`; passed to `setLoopDetection()` |
| `max_requests_per_minute` | integer | Burst limit: requests per sliding 60-second window per agent |
| `response_timeout_seconds` | integer | Timeout: seconds allowed between an oracle request event and its fulfillment |
| `action` | `"revoke"` | Action taken: calls `disableTool()` on violation |

**On-chain configuration** (`sync-autonomy-bounds.js`): reads `max_hops` and `loop_detection` and calls them on `ExecutionTraceLog` if `TRACE_LOG_ADDRESS` is set.

**Off-chain monitoring** (`bounds-monitor.js`): tracks burst windows per agent using `max_requests_per_minute`; tracks pending requests with a timeout map using `response_timeout_seconds`; calls `disableTool()` on violation.

---

## Extension 3 — `action_permits` (Concept 10)

**Location:** each tool object, alongside `autonomy_bounds`.

```json
"action_permits": {
  "classification": "pr_action",
  "tool_action": "PR:APPROVE",
  "default_tier": 1,
  "approval_timeout_seconds": 300,
  "violation_threshold": 3
}
```

| Field | Type | Description |
|---|---|---|
| `classification` | string | Human-readable action category (e.g. `"pr_action"`, `"sql_action"`) |
| `tool_action` | string | Pattern ID matching an entry in `action-patterns.json` (e.g. `"PR:APPROVE"`, `"SQL:DROP"`) |
| `default_tier` | 0–3 | Default authorization tier for this tool's action (see tier table below) |
| `approval_timeout_seconds` | integer | Tier 2 multi-sig: how long to poll for approvals before timing out |
| `violation_threshold` | integer | Number of `ActionBlocked` events before `bounds-monitor.js` calls `disableTool()` |

### Action tiers

| Tier | Name | Description | Requires |
|---|---|---|---|
| 0 | Read-only | No side effects; always allowed | Nothing |
| 1 | Reversible write | Creates or modifies state that can be undone | Flow permit granted by initiator |
| 2 | Destructive / multi-sig | Irreversible or high-impact; requires explicit human approval | Flow permit + N-of-M approvals |
| 3 | Forbidden | Never permitted regardless of context | — |

### On-chain component — `ActionPermitRegistry`

`action_permits` metadata drives the `ActionPermitRegistry` contract:

- `grantPermit(flowId, agentId, actionType, tier, requiredApprovals)` — called by flow initiator to authorize Tier 1 / Tier 2 actions
- `approveAction(flowId, agentId, actionType)` — accumulates Tier 2 approvals
- `validateAction(flowId, agentId, actionType)` — view function called by oracle contracts in layer 10 of the authorization stack

`actionType` is `keccak256(bytes(tool_action))` — e.g. `keccak256("PR:APPROVE")`.

### Off-chain component — `action-gateway.js`

`ActionGateway` reads `tool_action` from `action_permits` and `action-patterns.json` at startup:

- `classify(command)` — matches raw command text against regex patterns, returns tier
- `checkTool(toolName, args, flowId, agentId)` — full pre-flight: classify → validate on-chain → poll for Tier 2 approval if needed
- Tier 2 polling uses `approval_timeout_seconds`

### Violation escalation

`bounds-monitor.js` watches `ActionBlocked(traceId, agentId, actionType)` events emitted by oracle contracts when `validateAction` returns false. Each event increments a per-agent-per-tool counter; when the counter reaches `violation_threshold`, the monitor calls `AutonomyBoundsRegistry.disableTool()`.

---

## Suspension UX convention

When `AutonomyBoundsRegistry.isToolEnabled()` returns false, the MCP server signals suspension to callers through two standard MCP protocol points:

### `tools/list` response

Suspended tools include two extra fields:

```json
{
  "name": "review_pr",
  "description": "...",
  "inputSchema": { ... },
  "x_suspended": true,
  "x_suspension_reason": "Tool review_pr disabled by autonomy bounds monitor (anomaly: error rate 28%)"
}
```

Standard MCP clients ignore `x_suspended` / `x_suspension_reason`. ERC-8004-aware clients use them to surface the suspension to end users without making a failing tool call.

### `tools/call` response

Calling a suspended tool returns a JSON-RPC error:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Tool suspended: review_pr — anomaly: error rate 28%"
  }
}
```

Error code `-32001` is in the application-defined error range (MCP standard reserves `-32000` to `-32099` for implementation-defined errors).

State is persisted in `agents_implementation/bounds-state.json`, written by `bounds-monitor.js` and read by MCP servers on each `tools/list` and `tools/call` request.

---

## Full annotated example — `review_pr` tool

```json
{
  "name": "review_pr",
  "description": "Performs a code review on the specified pull request.",
  "inputSchema": { ... },
  "outputSchema": { ... },

  "autonomy_bounds": {
    "reputation": {
      "signal": "reputation_degradation",
      "min_score": 30,           // revoke if avg score falls below 30
      "min_score_decimals": 0,
      "min_feedback_count": 5,   // gate inactive until 5 feedback entries exist
      "tag": "review_code",      // filter reputation by this capability tag
      "action": "revoke"
    },
    "anomaly": {
      "signal": "anomaly_detection",
      "max_error_rate_pct": 20,  // revoke if error rate exceeds 20% in last 50 requests
      "window_requests": 50,
      "action": "revoke"
    },
    "performance": {
      "signal": "performance_degradation",
      "min_success_rate_pct": 80, // revoke if success rate drops below 80% in last 100 requests
      "window_requests": 100,
      "action": "revoke"
    },
    "flow": {
      "signal": "flow_anomaly",
      "max_hops": 20,             // on-chain: ExecutionTraceLog.setMaxHops(20)
      "loop_detection": true,     // on-chain: ExecutionTraceLog.setLoopDetection(true)
      "max_requests_per_minute": 10,      // off-chain burst detection
      "response_timeout_seconds": 300,    // off-chain timeout detection
      "action": "revoke"
    }
  },

  "action_permits": {
    "classification": "pr_action",
    "tool_action": "PR:READ",    // maps to a Tier 0 pattern — always allowed
    "default_tier": 0,
    "approval_timeout_seconds": 300,
    "violation_threshold": 3     // disableTool() after 3 ActionBlocked events
  }
}
```
