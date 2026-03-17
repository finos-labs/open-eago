# Prompt Governance (Concept 5)

## Problem

MCP treats prompts as first-class primitives (`prompts/list`, `prompts/get`) but defines no security properties — no versioning, no hashing, no signatures. ERC-8004 says nothing about prompts at all; `architecture.proposal.md` explicitly noted that prompts are "loaded as system prompt in MCP server; not stored on-chain."

In this codebase the agent prompt templates (e.g. `aml_screening`, `credit_assessment`) are static Handlebars strings stored in `agents/mcp/*.mcp.json`. A developer can change them silently — no audit trail, no on-chain record, no way for a verifier to know what instructions the agent was operating under when it produced a result.

---

## Solution

`PromptRegistry` stores `keccak256(templateText)` per `bytes32 capability` on-chain. Oracle contracts call `isActive(capability, hash)` as the fifth fulfillment gate: if the bridge submits an unrecognized hash, the transaction reverts with `"unrecognized prompt"`. Bridges compute the hash from the MCP spec file at startup and include it in every fulfillment params struct; the hash is then stored in the result struct for permanent audit.

---

## Design decisions

### Hard gate vs. soft advisory

The gate is **hard**: `require(promptRegistry.isActive(...), "unrecognized prompt")`. A soft advisory (emit an event, do not revert) would still allow fulfillments with rogue templates, defeating the purpose. An audit log alone does not prevent the attack; it only enables post-hoc detection.

### Hash-only on-chain vs. full template on-chain

Only `keccak256(template)` is stored, not the template text. Full templates can be kilobytes of natural language; storing them on-chain would be expensive and of no additional security benefit — a hash is sufficient to prove integrity. The full text lives in `agents/mcp/*.mcp.json` and is referenced by the optional `metadataUri` field (e.g., `"agents/mcp/aml-review.mcp.json"` or an IPFS CID).

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

### `AMLOracle`

- Added `IPromptRegistry public promptRegistry;`
- Added `setPromptRegistry(address) external onlyOwner` (emits `PromptRegistrySet`)
- Added `bytes32 promptHash` to `FulfillReviewParams` struct and `AMLResult` struct
- In `fulfillReview`, after the reputation gate check:

```solidity
if (address(promptRegistry) != address(0)) {
    require(promptRegistry.isActive(CAP_AML_REVIEW, params.promptHash), "unrecognized prompt");
}
req.status = RequestStatus.Fulfilled;
results[params.requestId] = AMLResult(
    traceId, params.resultHash, params.cleared,
    agentId, block.timestamp, params.promptHash   // hash stored for audit
);
```

### `CreditRiskOracle`

Same pattern. `bytes32 promptHash` added to `FulfillReviewParams`, `FulfillTermsParams`, and `CreditResult`. The internal `_validateAndSetStatus` helper accepts `promptHash` and performs the gate check before writing state.

---

## Bridge integration

All bridges compute `PROMPT_HASH` once at startup:

```javascript
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { ethers } from 'ethers';

const MCP_SPEC_PATH = resolve(__dirname, '..', 'agents', 'mcp', 'aml-review.mcp.json');
const mcpSpec = JSON.parse(readFileSync(MCP_SPEC_PATH, 'utf8'));
const PROMPT_TEMPLATE = mcpSpec.prompts[0].template;
const PROMPT_HASH = ethers.keccak256(ethers.toUtf8Bytes(PROMPT_TEMPLATE));
```

Before submitting a fulfillment transaction (defense-in-depth pre-flight):

```javascript
if (promptRegistry) {
    const ok = await promptRegistry.isActive(CAP_AML_REVIEW, PROMPT_HASH);
    if (!ok) {
        console.warn('Prompt hash not active — skipping fulfillment tx');
        return;
    }
}
```

`PROMPT_HASH` is included in every fulfillment params struct so the oracle can perform the same check on-chain.

---

## Deployment

`scripts/deploy.js` handles PromptRegistry deployment and prompt hash registration automatically (as part of the full-stack deploy):

```javascript
// scripts/deploy.js (step 14 + prompt registration block)
// Hashes langchain_messages (not raw template) to match Python bridge hashing
const amlSpec    = JSON.parse(fs.readFileSync(path.join(mcpDir, 'aml-review.mcp.json'),   'utf8'));
const creditSpec = JSON.parse(fs.readFileSync(path.join(mcpDir, 'credit-risk.mcp.json'),  'utf8'));
const amlHash    = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(JSON.stringify(amlSpec.prompts[0].langchain_messages)));
const creditHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(JSON.stringify(creditSpec.prompts[0].langchain_messages)));

const promptReg = await PromptReg.deploy();
await promptReg.registerPrompt(CAP_AML_REVIEW,    amlHash,    'agents/mcp/aml-review.mcp.json#v1-langchain');
await promptReg.registerPrompt(CAP_CREDIT_REVIEW, creditHash, 'agents/mcp/credit-risk.mcp.json#v1-langchain');
// Hashes are registered but NOT activated — call setActiveVersion(CAP_*, 0) to enforce the gate
// Call setPromptRegistry(promptRegAddr) on each oracle separately post-deploy
```

Bridges are launched with `--prompt-registry 0x<addr>` or `PROMPT_REGISTRY_ADDRESS=0x<addr>`.

---

## How to rotate a prompt

1. Edit `agents/mcp/aml-review.mcp.json` — update `prompts[0].template`.
2. Compute the new hash:
   ```javascript
   const newHash = ethers.keccak256(ethers.toUtf8Bytes(newTemplate));
   ```
3. Register the new version on-chain:
   ```solidity
   uint256 v1 = promptRegistry.registerPrompt(CAP_AML_REVIEW, newHash, "agents/mcp/aml-review.mcp.json");
   ```
4. Activate it:
   ```solidity
   promptRegistry.setActiveVersion(CAP_AML_REVIEW, v1);
   ```
5. Restart bridge processes — they recompute `PROMPT_HASH` from the updated spec file on startup.

**Rollback:** Re-activate any previous version index (`setActiveVersion(CAP_AML_REVIEW, 0)`) — takes effect immediately, no bridge restart needed for the old version.

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
- `contracts/AMLOracle.sol` — wired (`setPromptRegistry`, `isActive` check, `promptHash` in result)
- `contracts/CreditRiskOracle.sol` — wired (all fulfill paths gated via `_validateAndSetStatus`)
- `contracts/LegalOracle.sol`, `contracts/ClientSetupOracle.sol` — wired (same pattern)
- `agents_implementation_py/bridges/aml_bridge.py` — computes hash, pre-flight check, passes hash in tx
- `agents_implementation_py/bridges/credit_risk_bridge.py` — same
- `agents_implementation_py/bridges/legal_bridge.py`, `agents_implementation_py/bridges/client_setup_bridge.py` — same
- `agents_implementation_py/launch_bridges.py` — `--prompt-registry` / `PROMPT_REGISTRY_ADDRESS` threaded through
- `scripts/deploy.js` — deploys PromptRegistry (step 14), registers LangChain prompt hash v1 for AML/Credit/Legal (not yet activated); full wiring via `setPromptRegistry` on oracles done post-deploy
- `test/PromptRegistry.test.js` — 34 tests covering all functions + oracle integrations + full rotation cycle
