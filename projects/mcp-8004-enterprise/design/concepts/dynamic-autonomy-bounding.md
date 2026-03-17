# Dynamic Autonomy Bounding

## What it is

Dynamic Autonomy Bounding is a risk management pattern for agentic AI: an agent's allowed actions are **automatically restricted in real-time** based on observable signals — reputation degradation, anomaly detection, or performance degradation — without requiring a human to intervene.

The goal is to prevent cascading failures, scope creep, and undetected quality decay in autonomous, multi-step agent flows where the system cannot assume honest or reliable behaviour.

---

## Design principle: Declare in spec, enforce in stack

The MCP spec (`agents/mcp/*.mcp.json`) is a static document — it declares what tools an agent exposes and what they accept. In this implementation it is extended to carry a second payload: **the threshold configuration for each tool's autonomy bounds**.

Each tool entry gains an optional `autonomy_bounds` block:

```json
{
  "name": "screen_client",
  "description": "...",
  "inputSchema": { ... },
  "autonomy_bounds": {
    "reputation": {
      "signal": "reputation_degradation",
      "min_score": 30,
      "min_score_decimals": 0,
      "min_feedback_count": 5,
      "tag": "aml_review",
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
}
```

**This is not an extension to the MCP protocol.** The JSON-RPC API (`tools/list`, `tools/call`) is unchanged; MCP clients see standard tool definitions and ignore `autonomy_bounds`. The ERC-8004 governance toolchain — `scripts/deploy.js` and `bounds_monitor.py` — reads the block at deploy time and at runtime respectively.

The MCP spec thereby serves two audiences simultaneously:

| Audience | What they read | What they ignore |
|---|---|---|
| MCP clients (callers) | `name`, `description`, `inputSchema` | `autonomy_bounds` |
| ERC-8004 governance toolchain | `autonomy_bounds` thresholds | nothing relevant |

This makes the spec the **single source of truth** for both capability definition and access policy configuration. A threshold change is a spec commit, not a separate config change.

---

## Three signal types

### 1. Reputation degradation

**Source:** `ReputationRegistryUpgradeable` — existing on-chain feedback ledger.

**Mechanism:** `ReputationGate` already enforces score thresholds per capability on-chain (layer 4 of the oracle stack). The `autonomy_bounds.reputation` block makes the MCP spec the canonical source for what gets loaded into `ReputationGate`. `scripts/deploy.js` reads the block and calls `ReputationGate.setThreshold(capability, minScore, decimals, minCount, tag)`.

No new contracts needed — the existing gate handles enforcement.

### 2. Anomaly detection

**Source:** `FulfillmentFailed(traceId, agentId, reason)` events emitted by oracle contracts.

**Mechanism:** `bounds_monitor.py` maintains a sliding window of outcomes per agent per tool. When the error rate over `window_requests` exceeds `max_error_rate_pct`, the monitor calls `AutonomyBoundsRegistry.disableTool(agentId, toolHash, reason)`. The oracle checks `isToolEnabled()` before accepting fulfillment; the bridge performs the same check off-chain as a pre-flight.

### 3. Performance degradation

**Source:** `FulfillmentSucceeded(traceId, agentId)` events — same oracle contracts.

**Mechanism:** Same sliding window. When the success rate over `window_requests` drops below `min_success_rate_pct`, `bounds_monitor.py` calls `disableTool`. Recovery is automatic: when the window fully satisfies both thresholds again, the monitor calls `enableTool`.

---

## Components

### `AutonomyBoundsRegistry` (new contract)

```
mapping(agentId => mapping(toolHash => ToolState))
  ToolState { bool enabled, string disabledReason, uint256 disabledAt }

isToolEnabled(agentId, toolHash) → bool   // oracle + bridge check
disableTool(agentId, toolHash, reason)    // called by trusted monitor
enableTool(agentId, toolHash)             // re-enable after recovery
setMonitor(address)                       // owner sets trusted monitor
```

`toolHash = keccak256(bytes(toolName))` — parallel to capability hash convention.

Tools start enabled by default (`disabledAt == 0` → `isToolEnabled` returns `true`). Only an explicit `disableTool()` call makes the registry return `false`.

### `bounds_monitor.py` (off-chain process)

- Subscribes to `FulfillmentSucceeded` / `FulfillmentFailed` events from both oracle contracts
- Maintains a circular outcome buffer per `(agentId, toolName)`
- Evaluates both anomaly and performance thresholds after every event
- Calls `disableTool` / `enableTool` on-chain as appropriate
- Writes `bounds-state.json` alongside itself so MCP servers reflect suspension state without an RPC call

### Oracle enforcement (7th authorization layer)

Both oracle contracts check `autonomyBounds.isToolEnabled()` after all other layers:

```solidity
if (address(autonomyBounds) != address(0)) {
    if (!autonomyBounds.isToolEnabled(agentId, TOOL_HASH)) {
        emit FulfillmentFailed(traceId, agentId, "tool revoked by autonomy bounds");
        revert("tool revoked by autonomy bounds");
    }
}
```

### Bridge pre-flight

Both bridges check `isToolEnabled()` before calling the MCP server, parallel to the existing `reputationGate.meetsThreshold()` pre-flight. An agent whose tool is revoked generates no gas spend and no oracle event.

### MCP server revocation UX

When a tool is disabled, `tools/list` reflects it:

```json
{ "name": "screen_client", ..., "x_suspended": true, "x_suspension_reason": "anomaly: error rate 25% > threshold 20% (aml_review)" }
```

`tools/call` on a suspended tool returns JSON-RPC error `-32001` with the suspension message.

State is read from `bounds-state.json` on every request — no RPC dependency, no restart needed.

---

## `scripts/deploy.js` — autonomy bounds wiring

Run after compile or whenever MCP spec thresholds change:

```bash
npx hardhat node          # terminal 1
node scripts/deploy.js    # terminal 2
```

Relevant steps in `deploy.js`:
1. Reads `autonomy_bounds.reputation` from each tool in the MCP specs
2. Calls `ReputationGate.setThreshold()` for each capability
3. Deploys `AutonomyBoundsRegistry` and calls `setAutonomyBounds()` on oracle contracts

---

## Recovery

When signals recover — score rises, error/success rates normalize over a full window — `bounds_monitor.py` calls `enableTool()` automatically. The tool reappears in `tools/list` without `x_suspended`. No manual intervention required.

Recovery requires the *window to fully satisfy the threshold*, not just one good event. A window of 50 requests that briefly dips below threshold and then recovers must complete 50 clean requests before re-enabling.

---

## Summary

| Signal | Source | Detection | Enforcement |
|---|---|---|---|
| Reputation | `ReputationRegistry` feedback | `ReputationGate.meetsThreshold()` | Layer 4 (existing) |
| Anomaly | `FulfillmentFailed` events | Sliding error-rate window | `AutonomyBoundsRegistry` (layer 7) |
| Performance | `FulfillmentSucceeded` events | Sliding success-rate window | `AutonomyBoundsRegistry` (layer 7) |

All three signal thresholds are declared in the MCP spec and enforced by the authorization stack — not by the agent's own process.
