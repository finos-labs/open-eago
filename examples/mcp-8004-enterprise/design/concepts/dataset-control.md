# Dataset Control (Concept 6)

## Problem

AML and credit risk agents can silently consume any dataset — sanctions lists, risk model corpora, KYC document embeddings, few-shot screening libraries. MCP provides no mechanism to declare or restrict which data an agent uses during a tool invocation. ERC-8004 says nothing about datasets. Nothing in the five existing governance layers records or constrains the data that informed a fulfillment.

This creates two distinct gaps:

1. **Auditability** — the on-chain result struct records *what the agent concluded*, but not *what data it used to reach that conclusion*. A verifier cannot reconstruct the full input to the decision.
2. **Authorisation** — a flow initiator has no way to say "this review may only use the approved dataset for our codebase". An agent could use a stale dataset, a competitor's dataset, or a dataset that has since been revoked — and the oracle would accept the fulfillment regardless.

---

## Solution

`DatasetRegistry` adds a two-tier, opt-in dataset gate as the sixth authorization layer.

**Tier 1 — Global catalogue (owner-managed):**
The contract owner registers datasets (`registerDataset`) into a per-capability catalogue keyed by `bytes32 contentHash` (e.g., `keccak256` of the dataset file, or a pinned IPFS CID). The owner then explicitly marks each entry as globally approved (`approveGlobally`) or revokes it (`revokeGlobal`). Only registered, globally-approved datasets can appear in per-flow allowlists.

**Tier 2 — Per-flow allowlist (flow-initiator-managed):**
Before a flow starts, the initiator calls `approveForFlow(traceId, contentHashes[])` to declare which catalogue entries are permitted within that specific `traceId`. The policy is immutable once set — the same guarantee that `FlowAuthorizationRegistry` provides for agent capabilities.

Oracle contracts call `isApproved(traceId, capability, contentHash)` for each hash submitted in the fulfillment params. A revert propagates as `"dataset not approved"`. The hashes are stored in the result struct for permanent audit alongside the prompt hash, agent identity, and flow trace.

---

## Design decisions

### Content hash as dataset identity

The gate is keyed by `bytes32 contentHash` — a hash of the actual dataset content — rather than a URL or name. A URL is mutable; a content hash is not. Approving `keccak256(datasetBytes)` guarantees that the approved payload is exactly what was registered, not a later version at the same address. The `metadataUri` field (`registerDataset` third argument) stores the human-readable reference (IPFS CID, git path, S3 URI) as an off-chain pointer for enumeration and tooling, but it plays no role in the gate.

### Two tiers, not one

A single per-flow allowlist would let any flow initiator approve any content hash, including arbitrary or malicious datasets. The global catalogue acts as the root of trust: only hashes the owner has vetted appear in the catalogue, and only catalogue entries can be flow-approved. A flow initiator can restrict further (use a subset), but cannot expand beyond the global catalogue.

### Immutable flow policy

`approveForFlow` reverts on duplicate calls for the same `traceId`. This mirrors `FlowAuthorizationRegistry.createFlow`: once declared, the input constraints for a flow are fixed. An attacker who compromises the flow initiator after the flow starts cannot retroactively expand the dataset allowlist to cover a fulfillment already under way.

### Opt-in

`isApproved` returns `true` whenever either tier has no configuration:
- No globally-approved datasets for the capability → global check passes.
- No flow policy for the `traceId` → flow check passes.
- Neither configured → always passes.

This preserves backward compatibility with all existing flows and oracle contracts. Setting `datasetRegistry` to `address(0)` (or never calling `setDatasetRegistry`) skips the gate entirely at zero additional gas cost (single `ISZERO` check).

### Hard gate vs. soft advisory

The gate is a `require`, not an event. An advisory that merely logged the hash would still allow fulfillments with unapproved datasets, defeating the auditability guarantee. The bridge must submit only approved hashes; if it cannot, it should abort and log rather than submit a fulfillment that will revert on-chain.

### `_anyRegistered` flat index

`approveForFlow` checks `_anyRegistered[contentHash]` before admitting a hash to a flow policy. This prevents a flow initiator from approving a hash that was never catalogued — a phantom approval that could be exploited if the hash later happens to collide with something registered. The flat index spans all capabilities, so a hash registered under `aml_review` cannot be phantom-approved under `credit_risk` without being explicitly registered there.

### revokeGlobal restores opt-in when the last approval is removed

If the owner revokes every globally-approved dataset for a capability, `_hasGlobalApproved[capability]` is cleared. `isApproved` then returns `true` for all hashes (opt-in) until a new dataset is approved globally. This is intentional: a capability with no blessed datasets is in an unconfigured state, not a locked-out state. If locking-out is the intent, the owner should revoke approval and leave at least one other dataset approved — or set `datasetRegistry` to `address(0)` and use a different access-control pattern.

---

## Contract design

### `IDatasetRegistry.sol`

Minimal interface consumed by oracle contracts:

```solidity
interface IDatasetRegistry {
    function isApproved(bytes32 traceId, bytes32 capability, bytes32 contentHash)
        external view returns (bool);
}
```

### `DatasetRegistry.sol`

**Storage:**

```solidity
struct DatasetEntry {
    string  metadataUri;      // IPFS CID, git path, or URL
    uint256 registeredAt;
    bool    globallyApproved;
}

address public owner;

// capability → contentHash → entry (global catalogue)
mapping(bytes32 => mapping(bytes32 => DatasetEntry)) private _catalogue;
// capability → ordered list of content hashes (for enumeration)
mapping(bytes32 => bytes32[]) private _datasetList;
// capability → at least one dataset globally approved
mapping(bytes32 => bool) private _hasGlobalApproved;
// flat index: is this hash registered under any capability?
mapping(bytes32 => bool) private _anyRegistered;

// traceId → contentHash → allowed (per-flow allowlist)
mapping(bytes32 => mapping(bytes32 => bool)) private _flowApproved;
// traceId → flow policy exists (immutable once set)
mapping(bytes32 => bool) private _hasFlowPolicy;
// traceId → list of approved hashes (for enumeration)
mapping(bytes32 => bytes32[]) private _flowDatasetList;
```

**Owner-only functions (global catalogue):**

| Function | Description |
|---|---|
| `registerDataset(bytes32 capability, bytes32 contentHash, string metadataUri)` | Adds hash to the global catalogue. Reverts on zero hash or duplicate. Emits `DatasetRegistered`. |
| `approveGlobally(bytes32 capability, bytes32 contentHash)` | Marks a catalogued hash as globally approved for the capability. Reverts if not registered. Emits `DatasetApproved`. |
| `revokeGlobal(bytes32 capability, bytes32 contentHash)` | Removes global approval. Scans remaining entries; clears `_hasGlobalApproved` if none remain (restores opt-in). Emits `DatasetRevoked`. |

**Anyone (per-flow allowlist):**

| Function | Description |
|---|---|
| `approveForFlow(bytes32 traceId, bytes32[] contentHashes)` | Declares the flow's dataset allowlist. Reverts on zero traceId, duplicate call, or any hash not in the global catalogue (`_anyRegistered`). Immutable once set. Emits `FlowDatasetsApproved`. |

**View functions:**

| Function | Description |
|---|---|
| `isApproved(bytes32 traceId, bytes32 capability, bytes32 contentHash) → bool` | Core gate. See logic below. |
| `isRegistered(bytes32 capability, bytes32 contentHash) → bool` | True if registered in catalogue (any approval state). |
| `getDatasets(bytes32 capability) → bytes32[]` | All catalogued hashes for a capability, in registration order. |
| `getDatasetInfo(bytes32 capability, bytes32 contentHash) → (metadataUri, registeredAt, globallyApproved)` | Full entry for a catalogued hash. |
| `getFlowDatasets(bytes32 traceId) → bytes32[]` | All hashes approved for a flow, in insertion order. |
| `flowPolicyExists(bytes32 traceId) → bool` | True if `approveForFlow` has been called for this traceId. |

**`isApproved` logic:**

```solidity
function isApproved(bytes32 traceId, bytes32 capability, bytes32 contentHash)
    external view returns (bool)
{
    bool globalOk = !_hasGlobalApproved[capability]
        || _catalogue[capability][contentHash].globallyApproved;
    bool flowOk = !_hasFlowPolicy[traceId]
        || _flowApproved[traceId][contentHash];
    return globalOk && flowOk;
}
```

**Events:**

```
DatasetRegistered(bytes32 indexed capability, bytes32 indexed contentHash, string metadataUri)
DatasetApproved(bytes32 indexed capability, bytes32 indexed contentHash)
DatasetRevoked(bytes32 indexed capability, bytes32 indexed contentHash)
FlowDatasetsApproved(bytes32 indexed traceId, bytes32[] contentHashes)
```

---

## Oracle integration

### Position in authorization stack

```
onlyRegisteredOracle(agentId)              ← IdentityRegistryUpgradeable
  → flowAuth.isAuthorized(...)             ← FlowAuthorizationRegistry
    → reputationGate.meetsThreshold()      ← ReputationGate
      → promptRegistry.isActive(...)       ← PromptRegistry
        → datasetRegistry.isApproved(...)  ← DatasetRegistry   ← NEW
          → state change
```

### `AMLOracle`

- Added `IDatasetRegistry public datasetRegistry;`
- Added `setDatasetRegistry(address) external onlyOwner` (emits `DatasetRegistrySet`)
- Added `bytes32[] datasetHashes` to `FulfillReviewParams` struct and `AMLResult` struct
- Added `getResultDatasetHashes(bytes32 requestId) → bytes32[]` view function
- In `fulfillReview`, after the prompt gate check:

```solidity
if (address(datasetRegistry) != address(0)) {
    for (uint256 i; i < params.datasetHashes.length; i++) {
        require(
            datasetRegistry.isApproved(traceId, CAP_AML_REVIEW, params.datasetHashes[i]),
            "dataset not approved"
        );
    }
}
req.status = RequestStatus.Fulfilled;
results[params.requestId] = AMLResult(
    traceId, params.resultHash, params.cleared,
    agentId, block.timestamp, params.promptHash, params.datasetHashes  // hashes stored for audit
);
```

### `CreditRiskOracle`

Same pattern. `bytes32[] datasetHashes` added to `FulfillReviewParams`, `FulfillTermsParams`, and `CreditResult`. The internal `_validateAndSetStatus` helper accepts `bytes32[] calldata datasetHashes` and performs the loop check before writing state. All fulfill paths store the hashes in the result.

---

## Bridge integration

The bridge must compute content hashes for each dataset it uses and include them in the fulfillment params struct. The expected pattern mirrors prompt hash handling:

```javascript
// At startup or per-invocation: compute hash of the dataset content
const datasetBytes = readFileSync(DATASET_PATH);
const contentHash = ethers.keccak256(datasetBytes);

// Pre-flight check (defense-in-depth, saves gas on revert)
if (datasetRegistry) {
    const ok = await datasetRegistry.isApproved(traceId, CAP_REVIEW_CODE, contentHash);
    if (!ok) {
        console.warn('Dataset hash not approved for this flow — skipping fulfillment tx');
        return;
    }
}

// Include in fulfillment params
await reviewerOracle.fulfillReview(agentId, {
    requestId,
    prId,
    summaryJson,
    commentsJson,
    approved,
    promptHash,
    datasetHashes: [contentHash],   // ← submitted on-chain for gate + audit
});
```

> **Note:** Bridge integration (hash computation, pre-flight, params threading) is not yet implemented in `bridges/aml_bridge.py` or `bridges/credit_risk_bridge.py`. The on-chain gate accepts an empty `datasetHashes[]` (no dataset claimed), so existing bridges continue to work unmodified until dataset enforcement is enabled via `setDatasetRegistry`.

---

## Deployment

`scripts/deploy.js` handles deployment and wiring:

```javascript
const DatasetReg = await hre.ethers.getContractFactory("DatasetRegistry");
const datasetReg = await DatasetReg.deploy();
await reviewerOracle.setDatasetRegistry(await datasetReg.getAddress());
await approverOracle.setDatasetRegistry(await datasetReg.getAddress());
```

No datasets are registered at deploy time. Operators register and approve datasets separately after deployment using `registerDataset` + `approveGlobally`.

---

## How to manage datasets

**Register and approve a new dataset globally:**

```solidity
bytes32 hash = keccak256(datasetBytes);            // computed off-chain
datasetRegistry.registerDataset(CAP_REVIEW_CODE, hash, "ipfs://Qm...");
datasetRegistry.approveGlobally(CAP_REVIEW_CODE, hash);
```

**Restrict a specific flow to a subset:**

```solidity
// Called by the flow initiator before submitting the first oracle request
datasetRegistry.approveForFlow(traceId, [hash]);
```

**Revoke a dataset:**

```solidity
datasetRegistry.revokeGlobal(CAP_REVIEW_CODE, hash);
// Takes effect immediately: subsequent fulfillments submitting this hash revert.
// In-flight fulfillments already accepted are unaffected (they have already been stored).
```

**Rotate to a new dataset version:**

1. Register new hash: `registerDataset(CAP_REVIEW_CODE, newHash, "ipfs://Qm...")`
2. Approve new hash: `approveGlobally(CAP_REVIEW_CODE, newHash)`
3. Revoke old hash: `revokeGlobal(CAP_REVIEW_CODE, oldHash)` ← do this last, keeps gate active
4. Update bridges to use new dataset and compute new hash.

---

## Relationship to other governance layers

| Layer | Scope | Reverts with |
|---|---|---|
| Identity | Per-agent | `"not agentWallet"` |
| Flow authorization | Per-flow, per-capability | `"not authorized for flow"` |
| Reputation gating | Per-capability, per-agent | `"reputation threshold not met"` |
| Prompt governance | Per-capability | `"unrecognized prompt"` |
| **Dataset control** | **Per-flow, per-capability, per-hash** | **`"dataset not approved"`** |

All five layers are opt-in. The dataset layer is the most granular: it enforces constraints at the level of a specific content hash within a specific flow for a specific capability.

---

## Implementation status

- `contracts/DatasetRegistry.sol` — implemented
- `contracts/IDatasetRegistry.sol` — implemented
- `contracts/AMLOracle.sol` — wired (`setDatasetRegistry`, `isApproved` loop, `datasetHashes` in result, `getResultDatasetHashes`)
- `contracts/CreditRiskOracle.sol` — wired (all fulfill paths gated via `_validateAndSetStatus`)
- `contracts/LegalOracle.sol`, `contracts/ClientSetupOracle.sol` — wired (same pattern)
- `scripts/deploy.js` — deploys and wires all oracle contracts
- `test/DatasetRegistry.test.js` — 50 tests covering all functions + oracle integrations + all-gates revert order + end-to-end cycles
- `agents_implementation_py/bridges/aml_bridge.py` — **not yet** (bridge passes empty `datasetHashes: []`)
- `agents_implementation_py/bridges/credit_risk_bridge.py` — **not yet**
