# SUI Agentic Registry — Specification

A SUI Move adaptation of [ERC-8004 (Trustless Agents)](https://eips.ethereum.org/EIPS/eip-8004).

---

## §1 Overview

The SUI Agentic Registry is a permissionless, on-chain infrastructure for AI agent coordination. Three shared-object registries work together:

1. **Identity Registry** — agent registration, ownership, metadata
2. **Reputation Registry** — client feedback and scoring
3. **Validation Registry** — third-party validator assessments

---

## §2 Global Agent ID

Every agent is identified globally by:

```
sui:{network}:{identityRegistryObjectId}:{agentId}
```

| Field | Description |
|---|---|
| `sui` | Constant prefix identifying the SUI chain family |
| `network` | `mainnet`, `testnet`, or `devnet` |
| `identityRegistryObjectId` | 0x-prefixed SUI Object ID of the `AgentRegistry` shared object |
| `agentId` | Sequential u64 counter, unique within the registry |

---

## §3 Identity Registry

### §3.1 AgentRegistry (shared object)

```move
struct AgentRegistry has key {
    id: UID,
    counter: u64,
    agents: ObjectTable<u64, AgentEntry>,
}
```

### §3.2 AgentEntry

```move
struct AgentEntry has key, store {
    id: UID,           // dynamic field anchor
    agent_id: u64,
    owner: address,
    agent_uri: String,
    active: bool,
    created_at: u64,
    updated_at: u64,
}
```

Dynamic fields on `AgentEntry.id`:
- Metadata: arbitrary `String → vector<u8>` mappings
- Agent wallet: `b"agentWallet" → address`

### §3.3 AgentCap (ownership token)

```move
struct AgentCap has key, store {
    id: UID,
    agent_id: u64,
    registry_id: ID,
}
```

`AgentCap` is transferred to the registrant at registration time and serves as the sole ownership proof. Burned if the agent is deactivated.

### §3.4 Reserved metadata keys

| Key | Purpose | Setter |
|---|---|---|
| `agentWallet` | Associated on-chain wallet address | `set_agent_wallet()` / `unset_agent_wallet()` |

All other metadata keys are freely settable via `set_metadata()`.

---

## §4 Reputation Registry

### §4.1 FeedbackRecord

```move
struct FeedbackRecord has store, drop {
    value_negative: bool,
    value_magnitude: u128,
    value_decimals: u8,     // max 18
    tag1: String,
    tag2: String,
    is_revoked: bool,
    created_at: u64,
}
```

Signed feedback is encoded as `(bool is_negative, u128 magnitude)` since SUI Move has no native signed integer types.

Feedback key: `u64_to_bytes(agent_id) || ":" || bcs::to_bytes(client) || ":" || u64_to_bytes(feedback_index)`

### §4.2 Reliability thresholds

Discovery filters enforce minimum values regardless of caller input:

| Metric | Minimum |
|---|---|
| Reliability | 0.95 (95%) |
| Uptime | 99.00% |

### §4.3 Response annotation

`append_response()` emits a `ResponseAppended` event only. No on-chain state is stored (matches ERC-8004 §5.3 agent response intent — off-chain richness, on-chain provenance).

---

## §5 Validation Registry

### §5.1 ValidationEntry

```move
struct ValidationEntry has store, drop {
    validator_address: address,
    agent_id: u64,
    response: u8,           // 0–100
    response_hash: vector<u8>,
    tag: String,
    last_update: u64,
    responded: bool,
}
```

Validation key: `request_hash` (arbitrary `vector<u8>`, opaque to the contract).

### §5.2 Response finality model

Validators may submit multiple responses to the same request_hash (progressive finality). Each `validation_response()` call overwrites the previous response value. The most recent response is authoritative.

### §5.3 Score semantics

| Score | Meaning |
|---|---|
| 0 | Invalid / rejected |
| 1–49 | Below threshold |
| 50–79 | Acceptable |
| 80–99 | Good |
| 100 | Perfect / fully trusted |

---

## §6 Cross-registry validation

Both Reputation and Validation registries hold a reference to the `identity_registry_id`. All operations validate that:
1. The referenced agent exists in the Identity Registry
2. The agent is active (`active == true`)

Registries must be linked post-deployment via `initialize()`.

---

## §7 Event index

| Event | Module | Trigger |
|---|---|---|
| `AgentRegistered` | identity | `register()`, `register_empty()` |
| `URIUpdated` | identity | `set_agent_uri()` |
| `MetadataSet` | identity | `set_metadata()`, `set_agent_wallet()` |
| `AgentWalletSet` | identity | `set_agent_wallet()` |
| `AgentWalletUnset` | identity | `unset_agent_wallet()` |
| `NewFeedback` | reputation | `give_feedback()` |
| `FeedbackRevoked` | reputation | `revoke_feedback()` |
| `ResponseAppended` | reputation | `append_response()` |
| `ValidationRequested` | validation | `validation_request()` |
| `ValidationResponded` | validation | `validation_response()` |
