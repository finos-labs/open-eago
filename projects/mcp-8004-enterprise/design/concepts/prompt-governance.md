# Prompt Governance (Concept 5)

## Problem

MCP treats prompts as first-class primitives (`prompts/list`, `prompts/get`) but defines no security properties — no versioning, no hashing, no signatures. ERC-8004 says nothing about prompts at all; `architecture.proposal.md` explicitly noted that prompts are "loaded as system prompt in MCP server; not stored on-chain."

In this codebase the two agent templates (`code_review`, `approve_pr_prompt`) are static Handlebars strings stored in `agents/mcp/*.mcp.json`. A developer can change them silently — no audit trail, no on-chain record, no way for a verifier to know what instructions the agent was operating under when it produced a result.

---

## Solution

`PromptRegistry` stores `keccak256(templateText)` per `bytes32 capability` on-chain. Oracle contracts call `isActive(capability, hash)` as the fifth fulfillment gate: if the bridge submits an unrecognized hash, the transaction reverts with `"unrecognized prompt"`. Bridges compute the hash from the MCP spec file at startup and include it in every fulfillment params struct; the hash is then stored in the result struct for permanent audit.

---

## Design decisions

### Hard gate vs. soft advisory

The gate is **hard**: `require(promptRegistry.isActive(...), "unrecognized prompt")`. A soft advisory (emit an event, do not revert) would still allow fulfillments with rogue templates, defeating the purpose. An audit log alone does not prevent the attack; it only enables post-hoc detection.

### Hash-only on-chain vs. full template on-chain

Only `keccak256(template)` is stored, not the template text. Full templates can be kilobytes of natural language; storing them on-chain would be expensive and of no additional security benefit — a hash is sufficient to prove integrity. The full text lives in `agents/mcp/*.mcp.json` and is referenced by the optional `metadataUri` field (e.g., `"agents/mcp/code-reviewer.mcp.json"` or an IPFS CID).

### Hash computed from raw template string

The bridge reads the raw `template` field from the MCP spec JSON directly (`mcpSpec.prompts[0].template`) rather than calling `prompts/get`, which renders the template with arguments and produces a different string per invocation. The static template text is what governs agent behaviour; it is what should be hashed.

### Opt-in

`isActive()` returns `true` when no active version is configured for a capability. This preserves backward compatibility: existing flows deployed before `PromptRegistry` existed are unaffected by its introduction.

---

## Contract design

### `IPromptRegistry.sol`

Minimal interface consumed by oracle contracts:

```solidity
interface IPromptRegistry {
    function isActive(bytes32 capability, bytes32 templateHash) external view returns (bool);
}
```

### `PromptRegistry.sol`

**Storage:**

```solidity
struct PromptVersion {
    bytes32 templateHash;
    string  metadataUri;   // git path, IPFS CID, etc.
    uint256 registeredAt;
}

address   public owner;
mapping(bytes32 => PromptVersion[]) private _versions;      // capability → version list
mapping(bytes32 => uint256)         private _activeVersion; // capability → active index
mapping(bytes32 => bool)            private _hasActive;     // capability → active version set?
```

**Owner-only functions:**

| Function | Description |
|---|---|
| `registerPrompt(bytes32 capability, bytes32 templateHash, string metadataUri) → uint256` | Appends a new version, emits `PromptRegistered`. Reverts on zero hash. |
| `setActiveVersion(bytes32 capability, uint256 version)` | Activates the version at `version` index, emits `PromptActivated`. Reverts if out of range. |
| `deactivate(bytes32 capability)` | Clears `_hasActive`, emits `PromptDeactivated`. `isActive` returns `true` again (opt-in restored). |

**View functions:**

| Function | Description |
|---|---|
| `isActive(bytes32 capability, bytes32 templateHash) → bool` | Core gate. Returns `true` if no active version, or if stored hash matches. |
| `getActivePrompt(bytes32 capability) → (version, templateHash, metadataUri, active)` | Current active version fields, or zero values if inactive. |
| `getPromptVersion(bytes32 capability, uint256 version) → (templateHash, metadataUri, registeredAt)` | Returns stored fields for any version. Reverts out of range. |
| `getVersionCount(bytes32 capability) → uint256` | Number of registered versions. |

**`isActive` logic:**

```solidity
function isActive(bytes32 capability, bytes32 templateHash) external view returns (bool) {
    if (!_hasActive[capability]) return true;   // opt-in: no active version → always passes
    return _versions[capability][_activeVersion[capability]].templateHash == templateHash;
}
```

**Events:**

```
PromptRegistered(bytes32 indexed capability, uint256 indexed version, bytes32 templateHash, string metadataUri)
PromptActivated(bytes32 indexed capability, uint256 indexed version, bytes32 templateHash)
PromptDeactivated(bytes32 indexed capability)
```

---

## Oracle integration

### Position in authorization stack

```
onlyRegisteredOracle(agentId)              ← IdentityRegistryUpgradeable
  → flowAuth.isAuthorized(...)             ← FlowAuthorizationRegistry
    → reputationGate.meetsThreshold()      ← ReputationGate
      → promptRegistry.isActive(...)       ← PromptRegistry   ← NEW
        → state change
```

### `CodeReviewerOracle`

- Added `IPromptRegistry public promptRegistry;`
- Added `setPromptRegistry(address) external onlyOwner` (emits `PromptRegistrySet`)
- Added `bytes32 promptHash` to `FulfillReviewParams` struct and `ReviewResult` struct
- In `fulfillReview`, after the reputation gate check:

```solidity
if (address(promptRegistry) != address(0)) {
    require(promptRegistry.isActive(CAP_REVIEW_CODE, params.promptHash), "unrecognized prompt");
}
req.status = RequestStatus.Fulfilled;
results[params.requestId] = ReviewResult(
    traceId, params.summaryJson, params.commentsJson, params.approved,
    agentId, block.timestamp, params.promptHash   // hash stored for audit
);
```

### `CodeApproverOracle`

Same pattern. `bytes32 promptHash` added to `FulfillDecisionParams`, `FulfillNeedsRevisionParams`, and `ApprovalResult`. The internal `_validateAndSetStatus` helper accepts `promptHash` and performs the gate check before writing state.

---

## Bridge integration

Both bridges compute `PROMPT_HASH` once at startup:

```javascript
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { ethers } from 'ethers';

const MCP_SPEC_PATH = resolve(__dirname, '..', 'agents', 'mcp', 'code-reviewer.mcp.json');
const mcpSpec = JSON.parse(readFileSync(MCP_SPEC_PATH, 'utf8'));
const PROMPT_TEMPLATE = mcpSpec.prompts[0].template;
const PROMPT_HASH = ethers.keccak256(ethers.toUtf8Bytes(PROMPT_TEMPLATE));
```

Before submitting a fulfillment transaction (defense-in-depth pre-flight):

```javascript
if (promptRegistry) {
    const ok = await promptRegistry.isActive(CAP_REVIEW_CODE, PROMPT_HASH);
    if (!ok) {
        console.warn('Prompt hash not active — skipping fulfillment tx');
        return;
    }
}
```

`PROMPT_HASH` is included in every fulfillment params struct so the oracle can perform the same check on-chain.

---

## Deployment

`deploy-registries.js` handles all wiring automatically:

```javascript
// Read MCP spec files and compute hashes
const reviewerSpec = JSON.parse(fs.readFileSync(path.join(mcpDir, 'code-reviewer.mcp.json'), 'utf8'));
const approverSpec = JSON.parse(fs.readFileSync(path.join(mcpDir, 'code-approver.mcp.json'), 'utf8'));
const reviewerHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(reviewerSpec.prompts[0].template));
const approverHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(approverSpec.prompts[0].template));

// Deploy and wire
const promptReg = await PromptReg.deploy();
await promptReg.registerPrompt(CAP_REVIEW_CODE, reviewerHash, 'agents/mcp/code-reviewer.mcp.json');
await promptReg.setActiveVersion(CAP_REVIEW_CODE, 0);
await promptReg.registerPrompt(CAP_APPROVE_PR, approverHash, 'agents/mcp/code-approver.mcp.json');
await promptReg.setActiveVersion(CAP_APPROVE_PR, 0);
await reviewerOracle.setPromptRegistry(promptRegAddr);
await approverOracle.setPromptRegistry(promptRegAddr);
```

No manual configuration is needed post-deploy. Bridges are launched with `--prompt-registry 0x<addr>` or `PROMPT_REGISTRY_ADDRESS=0x<addr>`.

---

## How to rotate a prompt

1. Edit `agents/mcp/code-reviewer.mcp.json` — update `prompts[0].template`.
2. Compute the new hash:
   ```javascript
   const newHash = ethers.keccak256(ethers.toUtf8Bytes(newTemplate));
   ```
3. Register the new version on-chain:
   ```solidity
   uint256 v1 = promptRegistry.registerPrompt(CAP_REVIEW_CODE, newHash, "agents/mcp/code-reviewer.mcp.json");
   ```
4. Activate it:
   ```solidity
   promptRegistry.setActiveVersion(CAP_REVIEW_CODE, v1);
   ```
5. Restart bridge processes — they recompute `PROMPT_HASH` from the updated spec file on startup.

**Rollback:** Re-activate any previous version index (`setActiveVersion(CAP_REVIEW_CODE, 0)`) — takes effect immediately, no bridge restart needed for the old version.

---

## Relationship to other governance layers

| Layer | Scope | Reverts with |
|---|---|---|
| Identity | Per-agent | `"not agentWallet"` |
| Flow authorization | Per-flow, per-capability | `"not authorized for flow"` |
| Reputation gating | Per-capability, per-agent | `"reputation threshold not met"` |
| **Prompt governance** | **Per-capability** | **`"unrecognized prompt"`** |

All four layers are opt-in. Any combination can be enabled independently by setting (or not setting) the corresponding address on the oracle contracts.

---

## Implementation status

- `contracts/PromptRegistry.sol` — implemented
- `contracts/IPromptRegistry.sol` — implemented
- `contracts/CodeReviewerOracle.sol` — wired (`setPromptRegistry`, `isActive` check, `promptHash` in result)
- `contracts/CodeApproverOracle.sol` — wired (all three fulfill paths gated)
- `agents_implementation/code-reviewer-bridge.js` — computes hash, pre-flight check, passes hash in tx
- `agents_implementation/code-approver-bridge.js` — same
- `agents_implementation/launch-bridges.js` — `--prompt-registry` / `PROMPT_REGISTRY_ADDRESS` threaded through
- `scripts/deploy-registries.js` — auto-deploys, registers, activates, and wires
- `test/PromptRegistry.test.js` — 34 tests covering all functions + oracle integrations + full rotation cycle
