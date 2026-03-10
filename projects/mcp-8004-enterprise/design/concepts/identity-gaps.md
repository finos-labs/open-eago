# Identity Gaps Analysis — ERC-8004 Agent Identity

This document catalogues the gaps between what `IdentityRegistryUpgradeable` currently
proves and what a fully auditable, tamper-evident identity layer would require. Each gap
is assigned a short ID, a severity rating, and a disposition (implemented / Concept 9 candidate / out of scope).

---

## Background

The current identity model establishes three first-class fields per agent token:

| Field | How stored | What it proves |
|---|---|---|
| `agentWallet` | `_metadata[agentId]["agentWallet"]` | The signing key that the bridge submits fulfillments from |
| `oracleAddress` | `_metadata[agentId]["oracleAddress"]` | The contract this agent is authorised to fulfil requests on |
| `tokenURI` | ERC-721 `_tokenURIs` | A pointer (IPFS CID, HTTP URL, `data:` URI) to the agent card JSON |

The `onlyRegisteredOracle` modifier in each oracle contract checks both `agentWallet` and
`oracleAddress` before accepting a fulfillment. These two fields are cleared on token
transfer so they cannot leak to a new owner.

---

## Gap Inventory

### Gap 1: Agent Card Content Is Unanchored (HIGH)

**Symptom.** `tokenURI` is a pointer. Nothing on-chain records what the card *said* at
any point in time. An operator can silently modify `alice.json` — change the endpoint,
add capabilities, rewrite the MCP spec reference — and the chain is none the wiser. Any
fulfillment made after the edit still looks identical to one made before it.

**Why it matters.** A compliance audit that needs to prove "this agent was authorised for
capability X at the time of fulfillment T" cannot do so from the chain alone. The card
content is the specification of the agent; if it can be changed without an on-chain trace,
the audit record is incomplete.

**Fix (Concept 9).** Add a `cardHash` reserved key storing `keccak256(rawCardFileBytes)`.
Set it at deploy time via `register-mocks.js`; validate it at bridge startup. See Concept 9
section below for full design.

**Status:** Implemented in Concept 9.

---

### Gap 2: MCP Spec Is Not Committed On-Chain (MEDIUM)

**Symptom.** The agent card JSON contains an `mcpSpec` field pointing to a separate
`*.mcp.json` file. Nothing on-chain records the hash of the MCP spec. The spec defines
tool names, input schemas, prompt templates, and `autonomy_bounds` thresholds. A
developer can change what a tool accepts or how the prompt is phrased without any
on-chain signal.

**Why it matters.** Concept 5 (Prompt Governance) already hashes individual prompt
*templates* via `PromptRegistry`. The MCP spec is broader — it also contains input
schemas, tool descriptions, and `autonomy_bounds` configuration. A spec change that
modifies a schema or threshold boundary is currently undetected.

**Partial mitigation.** Concept 5 catches prompt template changes. Concept 7 catches
threshold drift (since `sync-autonomy-bounds.js` re-reads the spec and updates
`ReputationGate` / `ExecutionTraceLog`). The gap that remains is schema and tool
definition drift.

**Disposition.** Out of scope for Concept 9. Addressed partially by Concepts 5 and 7.
Concept 10 (`ActionPermitRegistry`) addresses a different but related gap (action-level
authorization), not MCP spec hashing itself. Full MCP spec hashing remains a potential
future concept beyond Concept 10.

---

### Gap 3: Wallet Signature Expiry Window Is Narrow (LOW)

**Symptom.** `setAgentWallet` requires an EIP-712 signature with a deadline within
`MAX_DEADLINE_DELAY` (5 minutes). This is a tight window for multi-sig or hardware wallet
workflows, but it prevents indefinite replay. Not a gap in the audit record — it is a
usability concern.

**Disposition.** Not a gap in identity correctness. Out of scope.

---

### Gap 4: `tokenURI` Can Change Without An Event (MEDIUM)

**Symptom.** `setAgentURI` emits `URIUpdated`. However, the ERC-721 standard also allows
`_setTokenURI` to be called without any custom event — the base contract emits no event
for URI changes in the OpenZeppelin implementation used here. In practice, the override
path via `setAgentURI` does emit, but callers who bypass that function (e.g. via internal
logic added in a future upgrade) would produce silent URI changes.

**Mitigation.** UUPS upgradeability is owner-gated. Any upgrade that adds internal URI
mutation is an owner action and is itself visible on-chain as an upgrade event.

**Disposition.** Low residual risk given UUPS access control. Out of scope.

---

### Gap 5: Revoked / Burned Agents Leave Fulfillment History Orphaned (LOW)

**Symptom.** If an agent NFT is burned (transferred to `address(0)`), `agentWallet` and
`oracleAddress` are cleared, but the `ExecutionTraceLog` hops and oracle result structs
that reference that `agentId` remain on-chain. There is no on-chain record that the agent
was burned after the fact.

**Why it matters.** A retrospective audit reading `getTrace(traceId)` sees `agentId=N`
in the hops but cannot call `ownerOf(N)` because the token no longer exists — it reverts
with `ERC721NonexistentToken`. The audit is not broken (the trace is still there), but the
cross-reference breaks.

**Disposition.** Not a gap in the trace itself; the hop records are immutable. Tooling
issue only. Out of scope.

---

### Gap 6: Oracle Binding Is Not Validated Against Deployment Bytecode (LOW)

**Symptom.** `setOracleAddress` accepts any address. Nothing on-chain verifies that the
address is a contract, that it implements `IIdentityRegistry`, or that its bytecode matches
the expected implementation. A misconfigured deploy that passes an EOA or the wrong
contract would pass all identity checks but produce nonsensical results.

**Mitigation.** The `onlyRegisteredOracle` modifier in oracle contracts checks
`oracleAddress == address(this)` — so if the wrong contract is bound, the bridge's
fulfillment transactions will simply revert when submitted to the *correct* contract.

**Disposition.** Acceptable. The check-by-address pattern catches misconfigurations at
fulfillment time. Out of scope.

---

### Gap 7: Metadata Keys Have No Schema (LOW)

**Symptom.** Generic `setMetadata` / `getMetadata` accept any `string` key and `bytes`
value. There is no on-chain type registry that says "key `capability` must decode to a
`bytes32 capability hash`" or "key `endpoint` must be a valid UTF-8 string". The reserved
key mechanism (`_requireNotReserved`) prevents collision with first-class fields, but does
not enforce types for custom keys.

**Disposition.** By design — the generic metadata map is intentionally untyped for
extensibility. Out of scope.

---

### Gap 8: Card Hash Is Not Enforced At Fulfillment Time (MEDIUM)

**Symptom.** Even after Concept 9 is implemented (card hash stored on-chain, bridge
validates at startup), nothing in the oracle contract's fulfillment path checks that the
current on-chain card hash matches a hash submitted by the bridge.
The card hash is verified only at bridge startup, not per-fulfillment.

**Why it matters.** If the card is changed and the bridge is not restarted, the startup
check is not re-run. The on-chain hash becomes stale relative to the running bridge.

**Status: Implemented (Concept 9b).** All agent-called fulfillment functions in
`AMLOracle`, `CreditRiskOracle`, `LegalOracle`, and `ClientSetupOracle` now accept a
`bytes32 cardHash_` parameter. The internal `_checkCardHash(agentId, cardHash_)` helper
reads `identityRegistry.getCardHash(agentId)` and reverts with `"card hash mismatch"` if
the committed hash is non-zero and differs from the submitted value. Passing `bytes32(0)`
skips the check (opt-in per agent — agents with no committed hash are unaffected).

---

## Summary Table

| Gap | Description | Severity | Status |
|-----|-------------|----------|--------|
| 1 | Card content unanchored | HIGH | Concept 9 (implemented) |
| 2 | MCP spec not hashed on-chain | MEDIUM | Partial (Concepts 5 + 7); full spec hashing is future work beyond Concept 10 |
| 3 | Wallet deadline window | LOW | Out of scope (usability) |
| 4 | tokenURI change without event | MEDIUM | Low residual risk; out of scope |
| 5 | Burned agents orphan history | LOW | Out of scope (tooling issue) |
| 6 | Oracle binding not bytecode-checked | LOW | Caught at fulfillment; out of scope |
| 7 | Metadata keys untyped | LOW | By design; out of scope |
| 8 | Card hash not enforced per-fulfillment | MEDIUM | Implemented (Concept 9b) |

---

## Concept 9: Agent Card Integrity

**Problem.** Gap 1 — card content is mutable with no on-chain trace.

**Solution.** Add a `cardHash` reserved key to `IdentityRegistryUpgradeable` that stores
`keccak256(rawCardFileBytes)`. The hash is set by the deployer at registration time
(via `register-mocks.js`) and can be updated by the token owner or approved operator
(via `setCardHash(agentId, cardHash_)`). Like `agentWallet` and `oracleAddress`, the
`cardHash` is cleared on token transfer.

**Bridge validation.** Both oracle bridges read the raw card file bytes at startup, compute
the local hash, and compare it against `identityRegistry.getCardHash(agentId)`. If the
hashes differ, the bridge logs a loud warning but continues running — enforcement at
fulfillment time is a follow-up (Gap 8 / Concept 9b).

**Hash convention.** `keccak256(rawFileBytes)` of the JSON card as read from disk, with no
normalisation. Any whitespace or formatting change produces a different hash, which is the
desired sensitivity — the on-chain hash is a commitment to an exact byte sequence.

**Parallel to existing reserved keys.**

| Reserved key | Type | Set by | Cleared on transfer |
|---|---|---|---|
| `agentWallet` | `address` (20 bytes, `abi.encodePacked`) | `register()` or `setAgentWallet()` | Yes |
| `oracleAddress` | `address` (20 bytes, `abi.encodePacked`) | `register()` or `setOracleAddress()` | Yes |
| `cardHash` | `bytes32` (ABI-encoded) | `register-mocks.js` after `register()`, or `setCardHash()` | Yes |

**Concept 9b — implemented.** Oracle-level card hash enforcement is now in place.
All agent-called fulfillment functions across the four B2B oracle contracts accept a
`bytes32 cardHash_` parameter. The `_checkCardHash(agentId, cardHash_)` internal helper
verifies the committed on-chain hash at fulfillment time, reverting with
`"card hash mismatch"` on a non-zero mismatch. Passing `bytes32(0)` opts out of the check
(useful for agents with no committed hash or legacy test calls).

**Remaining enhancement (future).** Continuous bridge monitoring: the startup check is a
point-in-time validation. A future enhancement could watch for `CardHashSet` events and
re-validate the running bridge when the on-chain hash changes.
