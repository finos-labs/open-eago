# Distributed Tracing: Execution Chain Correlation Token

> **Date:** February 28, 2026  
> **Project:** botman_8004  
> **Status:** Implemented  
> **Depends on:** [architecture.proposal.md](./architecture.proposal.md), [8004.refactor.md](./8004.refactor.md)

---

## 1. Problem

An enterprise agentic workflow spans multiple agents, multiple on-chain transactions, and multiple off-chain MCP calls. Today there is no way to answer:

- Which agents participated in processing a specific PR?
- In what order did the interactions happen?
- Did the end-to-end chain complete, or did it stall at an intermediate step?
- Where in the pipeline did a failure occur?

Each oracle contract emits its own events, but there is no shared identifier linking a `ReviewRequested` event to the corresponding `ApprovalRequested` event, or either of them to the MCP tool calls that occurred off-chain in between.

---

## 2. Solution: `traceId`

Introduce a **`bytes32 traceId`** — a correlation token born once at the start of an execution chain and propagated unchanged through every on-chain event, bridge invocation, and MCP request until the chain terminates.

This is the distributed tracing pattern (analogous to OpenTelemetry's trace ID) applied to an on-chain/off-chain hybrid system.

```
traceId is born
      │
      ▼
CodeReviewerOracle.requestReview(prId, traceId, focus)
      │  event ReviewRequested(..., traceId)
      ▼
code-reviewer-bridge.js  ←  receives event with traceId
      │  POST /mcp  { review_pr, headers: X-Trace-Id }
      ▼
code-reviewer-server.js  ←  logs traceId
      │  returns { summary, comments, approved }
      ▼
code-reviewer-bridge.js  →  fulfillReview(agentId, requestId, prId, ...)
      │  contract reads traceId from storage
      │  event ReviewFulfilled(..., traceId)
      │
      │  if approved, hand off to approver with SAME traceId
      ▼
CodeApproverOracle.requestApproval(prId, traceId, reviewerAgent, message)
      │  event ApprovalRequested(..., traceId)
      ▼
code-approver-bridge.js  →  POST /mcp  { approve_pr, headers: X-Trace-Id }
      ▼
code-approver-server.js  ←  logs traceId
      │  returns { decision, reason }
      ▼
code-approver-bridge.js  →  fulfillApproval(agentId, requestId, prId, ...)
      │  contract reads traceId from storage
      │  event PRApproved(..., traceId)
      │
      └──  chain complete
```

---

## 3. On-Chain: Contract Changes

### 3.1 `CodeReviewerOracle.sol`

Add `traceId` to request and events. The `traceId` is stored in the request struct and read from storage during fulfillment (to avoid EVM stack-too-deep):

```solidity
event ReviewRequested(
    bytes32 indexed requestId,
    address indexed requester,
    string prId,
    bytes32 indexed traceId,       // NEW
    string focus,
    uint256 timestamp
);

event ReviewFulfilled(
    bytes32 indexed requestId,
    bytes32 indexed traceId,       // NEW
    bool approved,
    uint256 agentId,
    uint256 timestamp
);

function requestReview(
    string calldata prId,
    bytes32 traceId,               // NEW — caller provides or contract generates
    string calldata focus
) external returns (bytes32 requestId);

// traceId NOT passed to fulfillReview — contract reads it from storage via
// _validateAndFulfill() to stay within the EVM's 16-slot stack limit.
function fulfillReview(
    uint256 agentId,
    bytes32 requestId,
    string calldata prId,
    bytes calldata summaryJson,
    bytes calldata commentsJson,
    bool approved
) external onlyRegisteredOracle(agentId);
```

The `traceId` is stored in the `ReviewRequest` and `ReviewResult` structs.

### 3.2 `CodeApproverOracle.sol`

Same pattern — the `traceId` carries through from the review phase. Like the reviewer oracle, fulfillment functions do NOT take `traceId` as a parameter; it is read from request storage:

```solidity
event ApprovalRequested(
    bytes32 indexed requestId,
    address indexed requester,
    string prId,
    bytes32 indexed traceId,       // SAME traceId from review phase
    string reviewerAgent,
    uint256 timestamp
);

event PRApproved(
    bytes32 indexed requestId,
    bytes32 indexed traceId,       // SAME traceId
    uint256 agentId,
    uint256 timestamp
);

event RevisionRequested(
    bytes32 indexed requestId,
    bytes32 indexed traceId,
    uint256 agentId,
    uint256 timestamp
);

event PRRejected(
    bytes32 indexed requestId,
    bytes32 indexed traceId,
    uint256 agentId,
    uint256 timestamp
);

function requestApproval(
    string calldata prId,
    bytes32 traceId,               // SAME traceId — binds review to approval
    string calldata reviewerAgent,
    string calldata message
) external returns (bytes32 requestId);
```

### 3.3 Indexing

Because `traceId` is `indexed` on events, any consumer can reconstruct the full chain with a single filter:

```javascript
// Query all events across both oracles for one execution chain
const reviewFilter = reviewerOracle.filters.ReviewRequested(null, null, null, traceId);
const approvalFilter = approverOracle.filters.ApprovalRequested(null, null, null, traceId);

const allEvents = [
    ...await reviewerOracle.queryFilter(reviewFilter),
    ...await approverOracle.queryFilter(approvalFilter),
].sort((a, b) => a.blockNumber - b.blockNumber);
```

---

## 4. Off-Chain: Bridge and MCP Server Changes

### 4.1 Bridge — propagate `traceId`

The bridge reads the `traceId` from the emitted event and passes it to the MCP server as a header and tool argument:

```javascript
// code-reviewer-bridge.js
reviewerOracle.on("ReviewRequested", async (requestId, requester, prId, traceId, focus, timestamp) => {
    const agentEndpoint = pickEndpoint("code-review");

    const result = await fetch(`${agentEndpoint}/mcp`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Trace-Id": traceId                    // propagate off-chain
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: "review_pr",
                arguments: { pr_id: prId, trace_id: traceId }
            }
        })
    });

    const review = await result.json();

    // traceId NOT passed — contract reads it from request storage
    await reviewerOracle.fulfillReview(
        agentId, requestId, prId,
        ethers.toUtf8Bytes(JSON.stringify(review.result.summary)),
        ethers.toUtf8Bytes(JSON.stringify(review.result.comments)),
        review.result.approved
    );
});
```

### 4.2 Cross-agent handoff

When the reviewer bridge triggers an approval request (the chain continues), it passes the **same** `traceId`:

```javascript
// After review fulfillment, if approved, hand off to approver
await approverOracle.requestApproval(
    prId,
    traceId,                                          // SAME traceId — not a new one
    reviewerAgentEndpoint,
    "Auto-forwarded after review approval"
);
```

This is the critical invariant: **the `traceId` is born once and never changes across the entire execution chain.**

### 4.3 MCP server — log `traceId`

MCP servers log every request with the trace ID for off-chain debugging:

```javascript
// Inside tools/call handler
const traceId = req.headers["x-trace-id"] || params?.arguments?.trace_id || "unknown";
console.log(`[${traceId}] tools/call ${params.name} args=${JSON.stringify(params.arguments)}`);
```

This allows correlating on-chain events with off-chain server logs using the same identifier.

---

## 5. `traceId` Generation Strategy

### Option A: Deterministic (recommended for idempotency)

Derive from the initiating input so repeated calls with the same parameters yield the same trace:

```javascript
const traceId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
        ["string", "uint256", "uint256"],
        [prId, blockNumber, timestamp]
    )
);
```

**Pros:** Same input → same trace. Replaying a failed chain reuses the original `traceId`. Easy to reconstruct the trace ID from known inputs.

**Cons:** If the same PR is reviewed twice at different times, the caller must include a disambiguating factor (e.g. timestamp, nonce).

### Option B: Random

```javascript
const traceId = ethers.hexlify(ethers.randomBytes(32));
```

**Pros:** Simple. No collision risk.

**Cons:** Cannot be reconstructed from input alone — must always be looked up.

### Recommendation

Use **Option A** for the common case (the chain initiator computes the trace ID), with a fallback to Option B when the caller doesn't supply one (the oracle contract generates a random trace ID using `keccak256(abi.encodePacked(msg.sender, prId, block.timestamp, nonce++))`).

---

## 6. Optional: On-Chain Trace Log Contract

For enterprises that need a **single queryable audit trail** across all oracle contracts:

```solidity
// contracts/ExecutionTraceLog.sol

contract ExecutionTraceLog {

    struct Hop {
        address oracle;        // which oracle contract recorded this hop
        uint256 agentId;       // which registered agent performed the action
        string  action;        // "reviewRequested", "reviewFulfilled", "approvalRequested", etc.
        uint256 timestamp;
    }

    // traceId → ordered list of hops
    mapping(bytes32 => Hop[]) public traces;

    event HopRecorded(
        bytes32 indexed traceId,
        address indexed oracle,
        uint256 indexed agentId,
        string action,
        uint256 timestamp
    );

    function recordHop(
        bytes32 traceId,
        uint256 agentId,
        string calldata action
    ) external {
        traces[traceId].push(Hop(
            msg.sender,        // the oracle contract calling this
            agentId,
            action,
            block.timestamp
        ));
        emit HopRecorded(traceId, msg.sender, agentId, action, block.timestamp);
    }

    function getTrace(bytes32 traceId) external view returns (Hop[] memory) {
        return traces[traceId];
    }

    function getHopCount(bytes32 traceId) external view returns (uint256) {
        return traces[traceId].length;
    }
}
```

Each oracle contract calls `traceLog.recordHop(traceId, agentId, "reviewRequested")` in its request and fulfillment functions.

### Usage

```javascript
// Reconstruct full execution chain for a given traceId
const hops = await traceLog.getTrace(traceId);
for (const hop of hops) {
    console.log(`${hop.timestamp}  agent=${hop.agentId}  oracle=${hop.oracle}  action=${hop.action}`);
}
```

### Integration with oracle contracts

```solidity
// CodeReviewerOracle.sol — inside requestReview()
if (address(traceLog) != address(0)) {
    traceLog.recordHop(traceId, agentId, "reviewRequested");
}

// Inside fulfillReview()
if (address(traceLog) != address(0)) {
    traceLog.recordHop(traceId, agentId, "reviewFulfilled");
}
```

The `traceLog` address can be set to `address(0)` to disable tracing with no gas overhead beyond the `if` check.

---

## 7. What This Gives You

| Concern | Solution |
|---|---|
| Which agents participated? | Filter events by `traceId` across all oracle contracts |
| What order did things happen? | `Hop.timestamp` or block number ordering |
| Did the chain complete? | Check for a terminal event (`PRApproved`, `PRRejected`) with the `traceId` |
| Off-chain debugging | `X-Trace-Id` header in MCP server logs — same ID as on-chain |
| On-chain audit trail | `ExecutionTraceLog.getTrace(traceId)` returns every hop |
| Compliance / reporting | Single indexed `bytes32` ties together all transactions and events for one workflow run |
| Failure diagnosis | Missing terminal event means the chain stalled; last recorded hop pinpoints where |

---

## 8. Data Visibility in On-Chain Ledger

All data emitted and received by oracles is visible on-chain:

| Data | Where it lives |
|---|---|
| Review request parameters (`prId`, `focus`, `traceId`) | `ReviewRequested` event + `ReviewRequest` struct in storage |
| Review result (`summary`, `comments`, `approved`) | `ReviewFulfilled` event + `ReviewResult` struct in storage |
| Approval request parameters | `ApprovalRequested` event |
| Approval decision (`approved` / `needs_revision` / `rejected`) | `PRApproved` / `RevisionRequested` / `PRRejected` events |
| Which agent fulfilled which request | `agentId` field in every result struct and event |
| Full execution trace | `ExecutionTraceLog.getTrace(traceId)` |

The `bytes` payloads (summary, comments, reasons) are stored as raw JSON. Any block explorer or ethers.js call can read and decode them:

```javascript
const result = await reviewerOracle.getResultInfo(requestId);
const comments = JSON.parse(ethers.toUtf8String(result.comments));
```

On a private/enterprise chain (Besu, etc.), the full transaction input data is also available, so even the function call parameters are reconstructible from the ledger.

---

## 9. Impact on Existing Components

### Contracts

| File | Change |
|---|---|
| `CodeReviewerOracle.sol` | Add `traceId` to `requestReview()` and events. `fulfillReview()` reads `traceId` from request storage (not a parameter) to avoid stack-too-deep. Store in structs. Integrate `_recordHop()`. |
| `CodeApproverOracle.sol` | Add `traceId` to `requestApproval()` and all events. `fulfill*()` functions read `traceId` from storage via `_validateAndSetStatus()`. Integrate `_recordHop()`. |
| `ExecutionTraceLog.sol` | **New contract** — deployed alongside oracles, address passed to constructors |
| `IdentityRegistryUpgradeable.sol` | No changes |
| `ReputationRegistry.sol` | No changes |

### Off-chain

| File | Change |
|---|---|
| `code-reviewer-bridge.js` | Read `traceId` from event, pass as `X-Trace-Id` header and tool argument. `fulfillReview()` no longer takes `traceId` — contract reads it from storage. |
| `code-approver-bridge.js` | Same pattern. `fulfill*()` calls no longer take `traceId`. |
| `code-reviewer-server.js` | Log `traceId` from header/argument on every tool call |
| `code-approver-server.js` | Same pattern |
| `deploy-registries.js` | Deploy `ExecutionTraceLog` and pass its address to oracle constructors |

### Agent cards / MCP specs

No changes required. The `traceId` is an infrastructure concern — it flows through the bridge layer, not the MCP tool schemas. MCP servers receive it as a pass-through header.

---

## 10. Implementation Status

| Priority | Item | Status |
|---|---|---|
| High | Add `bytes32 traceId` to `CodeReviewerOracle` and `CodeApproverOracle` request/fulfill functions and events | ✅ Done |
| High | Update bridges to propagate `traceId` from event → MCP call → fulfillment tx | ✅ Done |
| Medium | Implement `ExecutionTraceLog.sol` and integrate with oracle contracts | ✅ Done |
| Medium | Add `traceId` to MCP server structured logs | ✅ Done |
| Medium | Update `deploy-registries.js` to deploy `ExecutionTraceLog` and pass to oracle constructors | ✅ Done |
| Low | Build a trace viewer — reads `ExecutionTraceLog.getTrace(traceId)` and renders the execution chain | Planned |
| Low | Add trace-based alerting — flag traces that lack a terminal event after N blocks | Planned |

