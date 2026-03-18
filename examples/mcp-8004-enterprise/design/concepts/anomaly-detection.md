# Flow-Level Anomaly Detection

> **Concept 8 — Status:** Implemented
> **Related:** [dynamic-autonomy-bounding.md](./dynamic-autonomy-bounding.md), [distributed_tracing.md](./distributed_tracing.md)

---

## Overview

Concept 7 (Dynamic Autonomy Bounding) monitors per-agent, per-tool outcome rates — it answers: *is this agent producing bad results?* What it cannot see is **flow-level structural failures** — problems that emerge from the shape of the execution chain rather than the quality of any single agent's output.

This concept adds four new anomaly types, all detected without changing oracle contracts or bridge logic:

| Anomaly type   | Example                                                  |
|----------------|----------------------------------------------------------|
| Loop           | AML agent called twice for the same onboarding flow              |
| Runaway depth  | A flow accumulates 25 hops when 20 is the declared limit         |
| Burst          | 15 AML screening requests arrive within a single minute          |
| Stuck response | A screening request is never fulfilled within 5 minutes          |

---

## Architecture split

The four anomaly types divide cleanly into two enforcement paths:

| Anomaly type | Detection point                            | Enforcement                               |
|--------------|--------------------------------------------|-------------------------------------------|
| Loop         | `ExecutionTraceLog.recordHop()` (on-chain) | Revert — transaction never lands          |
| Max hops     | `ExecutionTraceLog.recordHop()` (on-chain) | Revert — transaction never lands          |
| Burst        | `bounds_monitor.py` (off-chain)            | `AutonomyBoundsRegistry.disableTool()`    |
| Stuck/timeout| `bounds_monitor.py` (off-chain)            | `AutonomyBoundsRegistry.disableTool()`    |

**Why loops and max hops are on-chain:** `ExecutionTraceLog` sees every hop across all agents in a flow — it is the natural enforcement point. An on-chain revert guarantees no partial state lands anywhere. The bridge catches the error in its outer try/catch and logs it; no special handling is needed.

**Why burst and timeout are off-chain:** Both are inherently time-based. Solidity has no timers, no wall-clock, and no ability to sample request rates over a rolling window. They route through the existing `disableTool`/`enableTool` mechanism from Concept 7.

---

## `ExecutionTraceLog` — loop and hop-count enforcement

Two new policy fields, both disabled by default (opt-in):

```solidity
uint256 public maxHopsPerTrace;      // 0 = disabled
bool    public loopDetectionEnabled; // false = disabled
```

Configured by the owner:

```solidity
function setMaxHops(uint256 max_) external onlyOwner
function setLoopDetection(bool enabled_) external onlyOwner
```

`recordHop()` enforces both before writing:

```solidity
if (loopDetectionEnabled) {
    // iterate existing hops; revert("loop detected") if same (oracle, agentId, action) seen
}
if (maxHopsPerTrace > 0 && _traces[traceId].length >= maxHopsPerTrace) {
    revert("max hops exceeded");
}
```

The revert propagates through the oracle's `_recordHop()` helper and causes the entire fulfillment transaction to revert. No state changes land.

---

## `flow` signal block in MCP specs

Each tool's `autonomy_bounds` gains an optional `flow` block:

```json
"flow": {
  "signal": "flow_anomaly",
  "max_hops": 20,
  "loop_detection": true,
  "max_requests_per_minute": 10,
  "response_timeout_seconds": 300,
  "action": "revoke"
}
```

Field routing:
- `max_hops`, `loop_detection` → read by `scripts/deploy.js`, written to `ExecutionTraceLog` on-chain
- `max_requests_per_minute`, `response_timeout_seconds` → read by `bounds_monitor.py` at startup for off-chain enforcement

---

## `bounds_monitor.py` — burst and timeout detection

### Burst detection

On each `ReviewRequested` / `ApprovalRequested` event:
1. Push `Date.now()` to a per-contract timestamp buffer.
2. Trim entries older than 60 seconds.
3. If `buffer.length > max_requests_per_minute` and tool not already suspended → `disableTool("burst: N req/min > threshold M")`.
4. If `buffer.length <= max_requests_per_minute` and tool was suspended for burst → `enableTool()` (natural decay recovery).

### Timeout detection

**Tracking:** `ReviewRequested` / `ApprovalRequested` → add `requestId` to pending map with `receivedAt = Date.now()`.

**Resolution:** `ReviewFulfilled`, `PRApproved`, `RevisionRequested`, `PRRejected`, `ReviewCancelled`, `ApprovalCancelled` → remove `requestId` from pending map.

**Sweep:** `setInterval` every 30 seconds. For each pending entry where `Date.now() - receivedAt > response_timeout_seconds * 1000` → `disableTool("timeout: no response for Xs")` and remove from map.

### Recovery from timeout

A timeout suspension means the bridge's `isToolEnabled()` pre-flight will fail for subsequent requests, so no new fulfillments arrive. Recovery is therefore operator-driven: manually call `enableTool()` on `AutonomyBoundsRegistry`, which also clears the local `bounds-state.json` entry so MCP servers stop advertising `x_suspended`.

---

## `scripts/deploy.js` — configuring ExecutionTraceLog

The script reads `autonomy_bounds.flow` from all tool entries across both MCP specs and applies the most-restrictive policy:
- `max_hops`: minimum non-zero value across all tools that declare it
- `loop_detection`: `true` if any tool declares `true`

Requires `TRACE_LOG_ADDRESS` env var. Calls `traceLog.setMaxHops()` and `traceLog.setLoopDetection()` as the deployer.

---

## Recovery paths summary

| Anomaly   | How it manifests                       | Recovery                                                       |
|-----------|----------------------------------------|----------------------------------------------------------------|
| Loop      | Fulfillment tx reverts on-chain        | Fix the flow logic; no tool suspension occurs                  |
| Max hops  | Fulfillment tx reverts on-chain        | Fix the flow logic or raise the limit; no suspension           |
| Burst     | `disableTool` called; bridge skips     | Automatic when request rate drops below threshold (60 s window) |
| Timeout   | `disableTool` called; bridge skips     | Operator calls `enableTool` after resolving the stuck agent    |

---

## Verification checklist

1. `npm run compile` — contracts compile cleanly.
2. Set `loop_detection: true`, submit a flow that re-uses `(oracle, agentId, action)` → second fulfillment reverts with `"loop detected"`.
3. Set `max_hops: 3`, submit a flow that would generate 4 hops → 4th `_recordHop` reverts with `"max hops exceeded"`.
4. Flood oracle with >10 requests/min → monitor detects burst, calls `disableTool`, bridge pre-flight skips subsequent events.
5. Submit a request, do not fulfill it, wait >300 s → monitor calls `disableTool` on timeout.
6. Verify `tools/list` shows `x_suspended: true` for affected tool in cases 4 and 5.
7. Fulfill a request after burst recovery → bridge processes normally; MCP server shows tool re-enabled.
