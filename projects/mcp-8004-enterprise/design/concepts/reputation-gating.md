# Design: Reputation-Gated Actions for ERC-8004 Agent Workflows

> **Date:** March 1, 2026
> **Project:** botman_8004
> **Status:** Implemented
> **Depends on:** [architecture.proposal.md](./architecture.proposal.md), [distributed_tracing.md](./distributed_tracing.md), [flow-scoped-authorization.md](flow-scoped-authorization.md)

---

## 1. Problem

Flow-scoped authorization answers *who is allowed to participate in this flow*. It says nothing about the quality of that participation. In a governed enterprise workflow, it is not enough that an agent has been registered and permitted to act in a flow — the agent must also have a track record of doing so well.

Without a quality bar:

- A newly registered agent with no history can fulfill oracle requests immediately.
- A poorly performing agent is indistinguishable from a high-performing one.
- Operators have no on-chain lever to enforce quality standards before allowing an agent to act.

---

## 2. Solution: `ReputationGate`

Introduce a **`ReputationGate`** contract as a fourth layer in the authorization stack. Before an oracle fulfillment is accepted, the gate queries `ReputationRegistryUpgradeable.getSummary()` for the acting agent and checks the result against a configured threshold for the specific capability being exercised.

```
onlyRegisteredOracle(agentId)          ← identity check
  → flowAuth.isAuthorized(...)         ← flow participation check
    → reputationGate.meetsThreshold()  ← quality bar  ← NEW
      → state change
```

All three gates are opt-in and independently optional:
- `flowAuth == address(0)` → flow check skipped
- `reputationGate == address(0)` → reputation check skipped
- No threshold configured for a capability → `meetsThreshold()` returns `true`

---

## 3. Design Decisions

### 3.1 Per-capability thresholds

Each `bytes32 capability` (e.g. `keccak256("review_code")`) has its own independent threshold. An agent that excels at reviewing code but is unproven at approvals can be permitted for one capability and blocked for the other.

### 3.2 Trusted evaluator list

`ReputationRegistryUpgradeable.getSummary()` accepts a `clientAddresses[]` parameter — only feedback from those addresses is counted. `ReputationGate` maintains a configurable trusted evaluator list and passes it at call time. Feedback from untrusted sources is invisible to the gate.

### 3.3 Tag-filtered scoring

Each threshold stores a `tag` string (default: the capability name, e.g. `"review_code"`). This tag is passed to `getSummary()` so only feedback tagged with that capability-relevant label counts toward the score. An agent's approval-related reputation cannot substitute for review-related reputation.

### 3.4 Decimal-safe comparison

`ReputationRegistryUpgradeable` returns scores at whatever decimal precision the evaluators used (the mode of all feedback decimals). The threshold has its own `scoreDecimals` field. Rather than normalizing by division (risking precision loss), comparison is done by cross-multiplication:

```solidity
int256 lhs = int256(summaryValue) * int256(10 ** uint256(t.scoreDecimals));
int256 rhs = int256(t.minScore)   * int256(10 ** uint256(summaryValueDecimals));
return lhs >= rhs;
```

`int128` max is approximately 1.7 × 10³⁸; with a maximum exponent of 10¹⁸ and typical score values well below 10¹⁸, the `int256` product stays well within range.

### 3.5 Opt-in guard for empty evaluator list

`getSummary()` reverts if `clientAddresses` is empty. `ReputationGate.meetsThreshold()` guards this: if `_evaluators.length == 0`, it returns `true` without calling the registry. This preserves the opt-in contract — an unconfigured gate never blocks.

---

## 4. Contract Design

### 4.1 `IReputationRegistry.sol`

Minimal interface consumed by `ReputationGate` so it can call `getSummary()` without importing the full upgradeable contract:

```solidity
interface IReputationRegistry {
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);
}
```

Note: `count` is `uint64`, not `uint256` — matching the actual `ReputationRegistryUpgradeable` implementation.

### 4.2 `IReputationGate.sol`

Single-function interface consumed by oracle contracts, mirroring the `IFlowAuthorizationRegistry` pattern:

```solidity
interface IReputationGate {
    function meetsThreshold(uint256 agentId, bytes32 capability) external view returns (bool);
}
```

### 4.3 `ReputationGate.sol`

**Storage:**

```solidity
struct Threshold {
    int128  minScore;
    uint8   scoreDecimals;
    uint64  minCount;
    string  tag;
    bool    exists;
}

address   public owner;
IReputationRegistry public reputationRegistry;

mapping(bytes32 => Threshold) private _thresholds;   // capability → threshold
address[]                     private _evaluators;
mapping(address => bool)      private _evaluatorSet;  // O(1) membership check
```

**Owner-only configuration:**

| Function | Description |
|---|---|
| `setThreshold(bytes32 capability, int128 minScore, uint8 scoreDecimals, uint64 minCount, string tag)` | Configure or update a threshold. Reverts if `scoreDecimals > 18`. |
| `removeThreshold(bytes32 capability)` | Remove a threshold, restoring opt-in behaviour for that capability. |
| `addEvaluator(address)` | Add a trusted evaluator. Reverts on zero address or duplicate. |
| `removeEvaluator(address)` | Remove a trusted evaluator (swap-and-pop). Reverts if not present. |

**View functions:**

| Function | Description |
|---|---|
| `meetsThreshold(uint256 agentId, bytes32 capability)` | Called by oracle contracts. |
| `getThreshold(bytes32 capability)` | Returns full threshold struct fields. |
| `thresholdExists(bytes32 capability)` | Returns `true` if a threshold is configured. |
| `getEvaluators()` | Returns current trusted evaluator list. |

**`meetsThreshold` logic:**

```
1. No threshold for capability       → return true   (opt-in)
2. _evaluators.length == 0           → return true   (guard against getSummary revert)
3. Call getSummary(agentId, _evaluators, threshold.tag, "")
4. count < threshold.minCount        → return false
5. Cross-multiply to compare scores  → return (lhs >= rhs)
```

**Events:**

```solidity
event ThresholdSet(bytes32 indexed capability, int128 minScore, uint8 scoreDecimals, uint64 minCount, string tag);
event ThresholdRemoved(bytes32 indexed capability);
event EvaluatorAdded(address indexed evaluator);
event EvaluatorRemoved(address indexed evaluator);
```

---

## 5. Oracle Contract Integration

Both `CodeReviewerOracle` and `CodeApproverOracle` receive the same changes:

```solidity
import "./IReputationGate.sol";

IReputationGate public reputationGate;

event ReputationGateSet(address indexed reputationGate);

function setReputationGate(address reputationGate_) external onlyOwner {
    reputationGate = IReputationGate(reputationGate_);
    emit ReputationGateSet(reputationGate_);
}
```

**Insertion point in `CodeReviewerOracle.fulfillReview()`** — after the flow auth check, before the state change:

```solidity
if (address(reputationGate) != address(0)) {
    require(
        reputationGate.meetsThreshold(agentId, CAP_REVIEW_CODE),
        "reputation threshold not met"
    );
}
req.status = RequestStatus.Fulfilled;
```

**Insertion point in `CodeApproverOracle._validateAndSetStatus()`** — this internal function is called by all three fulfillment paths (`fulfillApproval`, `fulfillNeedsRevision`, `fulfillRejection`), so a single insertion point covers all three:

```solidity
if (address(reputationGate) != address(0)) {
    require(
        reputationGate.meetsThreshold(agentId, CAP_APPROVE_PR),
        "reputation threshold not met"
    );
}
req.status = newStatus;
```

---

## 6. Off-Chain: Bridge Defense-in-Depth

When `--reputation-gate` is provided, bridges perform an off-chain pre-flight check before submitting any fulfillment transaction:

```javascript
// code-reviewer-bridge.js
const REPUTATION_GATE_ABI = [
    'function meetsThreshold(uint256 agentId, bytes32 capability) view returns (bool)',
];

if (reputationGate) {
    const qualified = await reputationGate.meetsThreshold(AGENT_ID, CAP_REVIEW_CODE);
    if (!qualified) {
        console.warn(`[reviewer-bridge] Agent ${AGENT_ID} does not meet reputation threshold — skipping`);
        return;
    }
}
```

This is **defense-in-depth**: the on-chain contract performs the same check. The bridge-level check saves gas by avoiding a fulfillment transaction that would revert on-chain.

---

## 7. Deployment

`deploy-registries.js` deploys `ReputationGate` after `ReputationRegistryUpgradeable` (it needs the registry address) and wires it into both oracle contracts:

```javascript
// 7. Reputation Gate
const RepGate = await hre.ethers.getContractFactory("ReputationGate");
const repGate = await RepGate.deploy(reputationAddr);
await repGate.waitForDeployment();

await reviewerOracle.setReputationGate(repGateAddr);
await approverOracle.setReputationGate(repGateAddr);
```

No threshold is active at deploy time — the gate is fully opt-in until the operator configures thresholds and evaluators.

---

## 8. Example: Configuring a Threshold

```javascript
const CAP_REVIEW_CODE = ethers.keccak256(ethers.toUtf8Bytes("review_code"));

// Require at least 3 reviews with an average score ≥ 70 (0 decimals)
await reputationGate.addEvaluator(trustedEvaluatorAddress);
await reputationGate.setThreshold(CAP_REVIEW_CODE, 70, 0, 3, "review_code");

// Evaluator submits feedback after observing agent performance
await reputationRegistry.giveFeedback(
    agentId,
    80,          // score
    0,           // decimals
    "review_code",
    "",
    agentEndpoint,
    "ipfs://...",
    ethers.ZeroHash
);

// After 3 feedbacks averaging ≥ 70, meetsThreshold() returns true
const ok = await reputationGate.meetsThreshold(agentId, CAP_REVIEW_CODE);
// ok === true
```

---

## 9. What This Gives You

| Concern | Solution |
|---|---|
| Preventing unproven agents from acting | Set `minCount > 0` — zero-history agents are blocked |
| Enforcing quality standards | Set `minScore` — agents with poor average scores are blocked |
| Separating reviewer and approver quality bars | Per-capability thresholds — each capability governed independently |
| Controlling whose opinion counts | Trusted evaluator list — only designated evaluators' feedback is considered |
| Audit trail | `ThresholdSet` / `EvaluatorAdded` events record all gate configuration on-chain |
| Backward compatibility | No threshold configured → `meetsThreshold()` returns `true` — existing flows unaffected |
| Gas efficiency | Bridge pre-flight saves gas on reverts; `address(0)` check in oracle costs one `ISZERO` |

---

## 10. Relationship to Other Concepts

| Layer | Contract | Question answered |
|---|---|---|
| 1 — Identity | `IdentityRegistryUpgradeable` | Does this agent exist and is its wallet + oracle registered? |
| 2 — Tracing | `ExecutionTraceLog` | What did this agent do and in what order? |
| 3 — Flow authorization | `FlowAuthorizationRegistry` | Is this agent allowed to participate in **this specific flow**? |
| 4 — Reputation gating | `ReputationGate` | Has this agent **earned the right** to perform this capability? |

The four layers are complementary and independently optional. A deployment can use any combination.

---

## 11. Implementation Status

| Item | Status |
|---|---|
| `IReputationRegistry.sol`, `IReputationGate.sol` | ✅ Done |
| `ReputationGate.sol` with threshold storage, evaluator list, decimal-safe comparison | ✅ Done |
| `CodeReviewerOracle` — `setReputationGate`, inline check | ✅ Done |
| `CodeApproverOracle` — `setReputationGate`, inline check via `_validateAndSetStatus` | ✅ Done |
| Bridge pre-flight check (`--reputation-gate` / `REPUTATION_GATE_ADDRESS`) | ✅ Done |
| `deploy-registries.js` — deploy + wire | ✅ Done |
| `test/ReputationGate.test.js` — 38 tests including oracle integration and end-to-end | ✅ Done |
| Per-capability threshold management UI / admin tool | Planned |
| Automated threshold adjustment based on sliding window | Planned |
