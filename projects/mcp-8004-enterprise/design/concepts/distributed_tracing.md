# Distributed Tracing: Execution Chain Correlation Token

> **Date:** February 28, 2026  
> **Project:** botman_8004  
> **Status:** Implemented  
> **Depends on:** [architecture.proposal.md](./architecture.proposal.md), [8004.refactor.md](./8004.refactor.md)

---

## 1. Problem

An enterprise agentic workflow spans multiple agents, multiple on-chain transactions, and multiple off-chain MCP calls. Today there is no way to answer:

- Which agents participated in processing a specific onboarding request?
- In what order did the interactions happen?
- Did the end-to-end chain complete, or did it stall at an intermediate step?
- Where in the pipeline did a failure occur?

Each oracle contract emits its own events, but there is no shared identifier linking an `AMLReviewRequested` event to the corresponding `CreditReviewRequested` event, or either of them to the MCP tool calls that occurred off-chain in between.

---

## 2. Solution: `traceId`

Introduce a **`bytes32 traceId`** — a correlation token born once at the start of an execution chain and propagated unchanged through every on-chain event, bridge invocation, and MCP request until the chain terminates.

This is the distributed tracing pattern (analogous to OpenTelemetry's trace ID) applied to an on-chain/off-chain hybrid system.

```
traceId is born
      │
      ▼
AMLOracle.requestAMLReview(flowId, bankAmlAgentId, hfDocAgentId, traceId)
      │  event AMLReviewRequested(..., traceId)
      ▼
aml-bridge.js  ←  receives event with traceId
      │  POST /mcp  { screen_client, headers: X-Trace-Id }
      ▼
aml-server.js  ←  logs traceId
      │  returns { action: 'submit_recommendation', result_hash, cleared: true }
      ▼
aml-bridge.js  →  submitRecommendation(bankAmlAgentId, requestId, resultHash)
      │  contract reads traceId from storage
      │  event AMLReviewFulfilled(..., traceId)
      │
      │  AML cleared → OnboardingRegistry sets phase bit
      │  same traceId propagates to credit review (runs in parallel)
      ▼
CreditRiskOracle.requestCreditReview(flowId, bankCreditAgentId, hfCreditAgentId, traceId)
      │  event CreditReviewRequested(..., traceId)
      ▼
credit-risk-bridge.js  →  POST /mcp  { assess_credit, headers: X-Trace-Id }
      ▼
credit-risk-server.js  ←  logs traceId
      │  returns { action: 'propose_terms', terms_hash }
      ▼
credit-risk-bridge.js  →  proposeTerms(bankCreditAgentId, requestId, termsHash)
      │  contract reads traceId from storage
      │  event TermsProposed(..., traceId)
      │
      └──  continues through negotiation rounds with same traceId
```

---

## 3. On-Chain: Contract Changes

### 3.1 `AMLOracle.sol`

`traceId` is embedded in the `flowId` passed at request time and propagated through all events. The `traceId` is stored in the `AMLRequest` struct and read from storage during fulfillment (to avoid EVM stack-too-deep):

```solidity
event AMLReviewRequested(
    bytes32 indexed requestId,
    bytes32 indexed flowId,        // carries traceId
    uint256 bankAgentId,
    uint256 clientAgentId,
    uint256 timestamp
);

event AMLReviewFulfilled(
    bytes32 indexed requestId,
    bytes32 indexed flowId,        // same traceId
    bytes32 resultHash,
    bool    cleared,
    uint256 bankAgentId,
    uint256 timestamp
);

function requestAMLReview(
    bytes32 flowId,                // traceId — caller provides
    uint256 bankAgentId,
    uint256 clientAgentId
) external returns (bytes32 requestId);

// traceId NOT passed to submitRecommendation — contract reads it from request storage.
function submitRecommendation(
    bytes32 requestId,
    uint256 bankAgentId,
    bytes32 resultHash
) external onlyBankAgent(bankAgentId);
```

The `flowId` / `traceId` is stored in the `AMLRequest` struct and emitted on every event.

### 3.2 `CreditRiskOracle.sol`

Same pattern — the `traceId` carries through from the AML phase. Fulfillment functions read it from request storage:

```solidity
event CreditReviewRequested(
    bytes32 indexed requestId,
    bytes32 indexed flowId,        // SAME traceId
    uint256 bankAgentId,
    uint256 clientAgentId,
    uint256 timestamp
);

event TermsProposed(
    bytes32 indexed requestId,
    bytes32 indexed flowId,        // SAME traceId
    bytes32 termsHash,
    uint256 agentId,
    uint256 timestamp
);

event CreditReviewFulfilled(
    bytes32 indexed requestId,
    bytes32 indexed flowId,        // SAME traceId
    bytes32 resultHash,
    bool    approved,
    uint256 agentId,
    uint256 timestamp
);

function requestCreditReview(
    bytes32 flowId,                // SAME traceId — binds to AML phase
    uint256 bankAgentId,
    uint256 clientAgentId
) external returns (bytes32 requestId);
```

### 3.3 Indexing

Because `traceId` is `indexed` on events, any consumer can reconstruct the full chain with a single filter:

```javascript
// Query all events across both oracles for one execution chain
const amlFilter    = amlOracle.filters.AMLReviewRequested(null, null, null, traceId);
const creditFilter = creditOracle.filters.CreditReviewRequested(null, null, null, traceId);

const allEvents = [
    ...await amlOracle.queryFilter(amlFilter),
    ...await creditOracle.queryFilter(creditFilter),
].sort((a, b) => a.blockNumber - b.blockNumber);
```

---

## 4. Off-Chain: Bridge and MCP Server Changes

### 4.1 Bridge — propagate `traceId`

The bridge reads the `traceId` from the emitted event and passes it to the MCP server as a header and tool argument:

```javascript
// aml-bridge.js
amlOracle.on("AMLReviewRequested", async (requestId, flowId, bankAgentId, clientAgentId, timestamp) => {
    const traceId = flowId;                           // flowId carries the traceId
    const agentEndpoint = pickEndpoint("aml-review");

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
                name: "screen_client",
                arguments: { request_id: requestId, trace_id: traceId }
            }
        })
    });

    const screening = await result.json();

    // traceId NOT passed — contract reads it from request storage
    await amlOracle.submitRecommendation(
        bankAgentId, requestId,
        ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(screening.result)))
    );
});
```

### 4.2 Cross-agent handoff

When AML clears, the onboarding orchestrator (or `OnboardingRegistry` callback) triggers the credit risk phase, passing the **same** `traceId`:

```javascript
// After AML fulfillment — if cleared, advance to credit review
await creditOracle.requestCreditReview(
    flowId,                                           // SAME traceId — not a new one
    bankCreditAgentId,
    hfCreditAgentId
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
        ["uint256", "uint256", "uint256"],
        [bankParticipantId, hfParticipantId, timestamp]
    )
);
```

**Pros:** Same input → same trace. Replaying a failed onboarding chain reuses the original `traceId`. Easy to reconstruct the trace ID from known inputs.

**Cons:** If the same institution pair onboards twice at different times, the caller must include a disambiguating factor (e.g. timestamp, nonce).

### Option B: Random

```javascript
const traceId = ethers.hexlify(ethers.randomBytes(32));
```

**Pros:** Simple. No collision risk.

**Cons:** Cannot be reconstructed from input alone — must always be looked up.

### Recommendation

Use **Option A** for the common case (the chain initiator computes the trace ID), with a fallback to Option B when the caller doesn't supply one (the oracle contract generates a random trace ID using `keccak256(abi.encodePacked(msg.sender, bankParticipantId, block.timestamp, nonce++))`).

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

Each oracle contract calls `traceLog.recordHop(traceId, agentId, "amlReviewRequested")` in its request and fulfillment functions.

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
// AMLOracle.sol — inside requestReview()
if (address(traceLog) != address(0)) {
    traceLog.recordHop(traceId, agentId, "amlReviewRequested");
}

// Inside fulfillReview()
if (address(traceLog) != address(0)) {
    traceLog.recordHop(traceId, agentId, "amlReviewFulfilled");
}
```

The `traceLog` address can be set to `address(0)` to disable tracing with no gas overhead beyond the `if` check.

---

## 7. What This Gives You

| Concern | Solution |
|---|---|
| Which agents participated? | Filter events by `traceId` across all oracle contracts |
| What order did things happen? | `Hop.timestamp` or block number ordering |
| Did the chain complete? | Check for a terminal event (`OnboardingCompleted`, `OnboardingRejected`) with the `traceId` |
| Off-chain debugging | `X-Trace-Id` header in MCP server logs — same ID as on-chain |
| On-chain audit trail | `ExecutionTraceLog.getTrace(traceId)` returns every hop |
| Compliance / reporting | Single indexed `bytes32` ties together all transactions and events for one workflow run |
| Failure diagnosis | Missing terminal event means the chain stalled; last recorded hop pinpoints where |

---

## 8. Data Visibility in On-Chain Ledger

All data emitted and received by oracles is visible on-chain:

| Data | Where it lives |
|---|---|
| AML request parameters (`flowId`, `bankAgentId`, `clientAgentId`, `traceId`) | `AMLReviewRequested` event + `AMLRequest` struct in storage |
| AML result (`resultHash`, `cleared`) | `AMLReviewFulfilled` event + result struct in storage |
| Credit request parameters | `CreditReviewRequested` event |
| Credit terms / decision | `TermsProposed` / `CreditReviewFulfilled` events |
| Legal draft / approval | `LegalDraftIssued` / `LegalContractExecuted` events |
| Client setup steps | `LegalEntitySetup` / `AccountSetup` / `ProductsSetup` events |
| Which agent fulfilled which request | `agentId` field in every result struct and event |
| Full execution trace | `ExecutionTraceLog.getTrace(traceId)` |

The `bytes` payloads (result hashes, reasons) are stored as raw bytes or JSON. Any block explorer or ethers.js call can read and decode them:

```javascript
const result = await amlOracle.getResultInfo(requestId);
const cleared = result.cleared;
```

On a private/enterprise chain (Besu, etc.), the full transaction input data is also available, so even the function call parameters are reconstructible from the ledger.

---

## 9. Impact on Existing Components

### Contracts

| File | Change |
|---|---|
| `AMLOracle.sol` | `traceId` embedded in `flowId` passed at request time; propagated through all events. `submitRecommendation()` reads `traceId` from `AMLRequest` storage. Integrate `_recordHop()`. |
| `CreditRiskOracle.sol` | Same pattern — `traceId` flows from AML phase via same `flowId`. All `fulfill*()` functions read `traceId` from storage. Integrate `_recordHop()`. |
| `LegalOracle.sol` | Same pattern across draft / markup / execution lifecycle events. |
| `ClientSetupOracle.sol` | Same pattern across three sequential setup phases. |
| `ExecutionTraceLog.sol` | **New contract** — deployed alongside oracles, address passed to constructors |
| `IdentityRegistryUpgradeable.sol` | No changes |
| `ReputationRegistryUpgradeable.sol` | No changes |

### Off-chain

| File | Change |
|---|---|
| `aml-bridge.js` | Read `traceId` from event (`flowId`), pass as `X-Trace-Id` header and tool argument. `submitRecommendation()` no longer takes `traceId` — contract reads it from storage. |
| `credit-risk-bridge.js` | Same pattern. `proposeTerms()` / `fulfillReview()` read `traceId` from storage. |
| `legal-bridge.js` | Same pattern across draft / markup / execution events. |
| `client-setup-bridge.js` | Same pattern across three setup phase events. |
| `aml-server.js` | Log `traceId` from header/argument on every tool call |
| `credit-risk-server.js` | Same pattern |
| `deploy-registries.js` | Deploy `ExecutionTraceLog` and pass its address to oracle constructors |

### Agent cards / MCP specs

No changes required. The `traceId` is an infrastructure concern — it flows through the bridge layer, not the MCP tool schemas. MCP servers receive it as a pass-through header.

---

## 10. Implementation Status

| Priority | Item | Status |
|---|---|---|
| High | Add `bytes32 traceId` (as `flowId`) to `AMLOracle`, `CreditRiskOracle`, `LegalOracle`, `ClientSetupOracle` request/fulfill functions and events | ✅ Done |
| High | Update bridges to propagate `traceId` from event → MCP call → fulfillment tx | ✅ Done |
| Medium | Implement `ExecutionTraceLog.sol` and integrate with oracle contracts | ✅ Done |
| Medium | Add `traceId` to MCP server structured logs | ✅ Done |
| Medium | Update `deploy-registries.js` to deploy `ExecutionTraceLog` and pass to oracle constructors | ✅ Done |
| Low | Build a trace viewer — reads `ExecutionTraceLog.getTrace(traceId)` and renders the execution chain | Planned |
| Low | Add trace-based alerting — flag traces that lack a terminal event after N blocks | Planned |

