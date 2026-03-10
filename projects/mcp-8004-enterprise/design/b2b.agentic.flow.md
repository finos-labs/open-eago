# B2B Agentic Flow — Cross-Bank Architecture

> **Status:** Partially implemented — P2 (bilateral flow authorization, credentialed Tier 2 approvers), P3 (reputation anti-gaming, audit exporter), and P4 (ConsortiumGovernance) are implemented in contracts/tests. P0 (payload privacy, ParticipantRegistry minting gate on IdentityRegistry) and P1 (multi-sig governance, HSM) are infrastructure concerns not yet wired.
> **Context:** Does the ERC-8004 / MCP stack extend naturally to a cross-bank, permissioned blockchain running inter-bank agentic workflows? What controls are missing?
> **Baseline:** [architecture.proposal.md](./architecture.proposal.md) — current system design; [concepts.md](./concepts.md) — 10 governance layers
> **Reference implementation:** [onboarding.flow.md](./onboarding.flow.md) — institutional client onboarding flow; full agent roster, oracle contracts, and topology for a bank ↔ hedge fund onboarding scenario

---

## Topology

The proposed network topology maps cleanly onto established financial DMZ architecture:

```
  BANK A                                    BANK B
  ──────────────────────────────────────    ──────────────────────────────────────
  Internal network                          Internal network
    MCP servers (all agents)                  MCP servers (all agents)
    Internal data sources                     Internal data sources
    HSM (oracle signing keys)                 HSM (oracle signing keys)
  DMZ — internal tier (submit-only)         DMZ — internal tier (submit-only)
    Internal agent bridges                    Internal agent bridges
    (orchestrator, setup agents)              (orchestrator, setup agents)
  DMZ — external tier (bidirectional)       DMZ — external tier (bidirectional)
    External agent bridges                    External agent bridges
    (negotiation, review, document)           (negotiation, review, document)
    EVM node (validator/RPC)                  EVM node (validator/RPC)
  ──────────────────── Consortium Chain ──────────────────────────────────────────
                       (permissioned EVM — Hyperledger Besu / Quorum / private PoA)
```

**Internal tier bridges** submit transactions only — no inbound events from counterparty institutions ever reach them. **External tier bridges** subscribe to chain events from both their own institution and counterparties; all inter-institution communication is mediated by the chain, never direct bridge-to-bridge.

For the concrete agent-to-tier mapping, see [onboarding.flow.md — Network Topology](./onboarding.flow.md).

**What goes on-chain:** agent NFT IDs, wallet addresses, `bytes32` hashes (traceIds, cardHashes, promptHashes, datasetHashes), approval/reject decisions, reputation counts, execution hop log.

**What stays behind firewalls:** agent logic, model inference, raw payload content, private keys, internal data.

The MCP servers never touch the chain. Bridges are the only process that straddles the DMZ boundary. This boundary is exactly right for a financial network: the chain is the shared ledger; the intelligence and data remain sovereign to each bank.

---

## What the current design already handles

| Concern | Existing mechanism |
|---|---|
| Agent identity | ERC-721 NFT in `IdentityRegistryUpgradeable` — pseudonymous but auditable |
| Oracle binding | `oracleAddress` reserved key — only the registered oracle can fulfill |
| Payload integrity | `promptHash`, `datasetHashes` in oracle fulfillment structs |
| Agent card integrity | `cardHash` reserved key (Concept 9) |
| Execution audit trail | `ExecutionTraceLog` — tamper-evident ordered hop log |
| Dynamic tool revocation | `AutonomyBoundsRegistry.disableTool()` |
| Action tiering | `ActionPermitRegistry` — Tier 0–3 with multi-sig for Tier 2 |
| Flow scoping | `FlowAuthorizationRegistry` (Concept 3) |
| Reputation | `ReputationRegistryUpgradeable` — per-agent, per-client |
| Structural anomaly detection | Loop detection, max hops, burst, timeout (Concept 8) |

The foundation is sound. The following sections identify what must be added or changed for cross-bank production deployment.

---

## Additional controls required

### P0 — Payload privacy: nothing sensitive on-chain

**Problem:** Oracle contracts currently store `summaryJson` and `commentsJson` as raw `bytes` on-chain. In an inter-bank context this is a hard blocker — review content, decision rationale, and internal business data cannot be written to a shared ledger.

**Solution:**
- Replace `summaryJson`/`commentsJson` fields in fulfillment structs with `payloadHash` (`bytes32`)
- Raw payload goes to off-chain encrypted storage (bank-controlled; e.g. private IPFS, S3 with bank mTLS certs) addressed by the hash
- Consumers fetch payload out-of-band; the on-chain hash proves integrity
- `promptHash` and `datasetHashes` already follow this pattern — apply it uniformly

### P0 — Permissioned agent minting

**Problem:** Any EOA can currently mint an agent NFT and register as a participant in a flow. In a consortium, an attacker (or rogue employee) could register a malicious agent.

**Solution:**
- Deploy a **ParticipantRegistry** contract: tracks approved institutions (banks and institutional clients) with `participantType` (BANK | CLIENT), `deploymentTier` (BANK_INTERNAL | BANK_EXTERNAL | CLIENT_EXTERNAL), and per-institution approver sets — all governed by multi-sig
- `IdentityRegistryUpgradeable.register()` checks `participantRegistry.isApprovedMinter(msg.sender)`
- Agent NFTs carry implicit institutional provenance: `participantOf(agentId)` reads through `ParticipantRegistry`
- The `deploymentTier` field makes the network topology machine-readable: ops tooling uses it to determine which DMZ tier and firewall rules apply to each agent's bridge
- Minting permission is separate from validator node membership
- For the full `ParticipantRegistry` interface, see [onboarding.flow.md — ParticipantRegistry](./onboarding.flow.md)

### P1 — Multi-sig contract governance

**Problem:** All contracts use `Ownable` with a single EOA as owner. A single compromised key can upgrade contracts, change reputation thresholds, disable loop detection, or register arbitrary action patterns.

**Solution:**
- Replace `owner` with a **Gnosis Safe** multisig whose signers are designated governance addresses at each member bank (M-of-N across banks)
- Applies to: `IdentityRegistryUpgradeable` (UUPS upgrade authority), `AutonomyBoundsRegistry`, `ExecutionTraceLog`, `ActionPermitRegistry`, `ReputationGate`
- Critical parameter changes (max hops, reputation thresholds, action tier assignments) go through the multi-sig

### P1 — HSM key management for bridges

**Problem:** The bridge process holds the oracle private key that signs fulfillment transactions. Currently read from env vars or key files — inadequate for a financial context.

**Solution:**
- Keys stored in HSM (Thales, AWS CloudHSM, Azure Dedicated HSM)
- Bridge signing calls HSM API (`sign(digest)`) rather than holding raw key material
- Each bank operates its own HSM; no cross-bank key sharing
- Key rotation is supported by the existing `setAgentWallet` EIP-712 flow — the oracle wallet can be rotated without changing the oracle contract binding

### P2 — Bilateral cross-bank flow authorization

**Problem:** The `FlowAuthorizationRegistry` (Concept 3) lets a flow initiator declare which agents may participate. But this is unilateral: Bank A can authorize Bank B's agent without Bank B's knowledge or consent.

**Solution:**
- `grantFlowParticipation(flowId, agentId)` checks that `msg.sender` is from the bank that registered `agentId` (via ParticipantRegistry) — i.e. Bank B's agents can only be added to a flow by Bank B
- The flow initiator (Bank A) declares the flow; each bank independently consents by calling `authorizeAgentForFlow(flowId, agentId)` for its own agents
- A flow spanning N banks requires N separate authorization calls before any hop involving a cross-bank agent can proceed

### P2 — Bank-credentialed Tier 2 approvers

**Problem:** `ActionPermitRegistry.approveAction()` is open to any EOA. For destructive cross-bank actions (e.g. `SQL:DELETE`, regulatory data submission), approvals must come from credentialed humans at the appropriate bank.

**Solution:**
- `ParticipantRegistry` tracks approved human approvers and senior approvers per institution: `mapping(bytes32 participantId => address[]) approvers`
- `ActionPermitRegistry.approveAction()` requires `participantRegistry.isApprover(msg.sender)`
- Quorum configuration: e.g. 2 approvers from the initiating institution + 1 from the executing agent's institution for Tier 2 actions
- For actions requiring bilateral approval (e.g. `legal:execute_contract`), `ActionPermitRegistry` supports a `requiredParticipants[]` list — one approver from each institution must sign off
- The `approval_timeout_seconds` field in `action_permits` MCP spec enforces the time window on-chain

### P3 — Reputation integrity / anti-gaming

**Problem:** Any address can submit feedback to `ReputationRegistryUpgradeable`. A bank could systematically inflate its own agents' scores by submitting self-serving feedback from addresses it controls.

**Solution:**
- Track `participantId` of the feedback submitter (via ParticipantRegistry lookup on `msg.sender`)
- `getSummary` gains a `trustedParticipants[]` filter: only feedback from specified participant IDs is counted
- Optionally: weight feedback by governance stake rather than equal-weight average
- An institution cannot count its own feedback toward its own agents' reputation without explicit trust grants from other participants

### P3 — Regulatory audit exporter

**Problem:** `ExecutionTraceLog` records hops on-chain but regulators require structured, searchable, jurisdictionally-scoped reports. Chain data is not directly queryable by compliance tools.

**Solution:**
- Off-chain **audit exporter** service per bank: indexes chain events into a queryable store (Postgres, Elasticsearch)
- Covers: agent identity, bank provenance, traceId, timestamps, payloadHashes, decisions, revocations, action blocks
- Reports are cryptographically verifiable — event data is signed by the validator set
- Data residency: each bank's exporter indexes only events involving its own agents; cross-bank events appear in both banks' indexes
- Export format: structured JSON with embedded Merkle proof of the originating block

### P4 — Consortium governance contract

**Problem:** Adding/removing member banks, changing shared parameters (global hop limits, emergency pause), and proposing contract upgrades currently have no on-chain coordination mechanism.

**Solution:**
- A **ConsortiumGovernance** contract:
  - Bank membership: propose → M-of-N vote → add/remove
  - Shared parameter changes: same vote threshold
  - Contract upgrade proposals: proposal → voting period → timelock → execute
  - Emergency circuit-breaker: any single bank can halt cross-bank flows (`pauseCrossBank()`); restoring requires M-of-N
  - Intra-bank flows are not affected by the cross-bank pause

### Infrastructure hardening (no contract changes)

- **EVM nodes:** static peer allowlist (`static-nodes.json`), only consortium member IPs
- **Bridges ↔ EVM node:** mTLS; bridge uses bank's internal CA cert
- **Bridges ↔ MCP server:** mTLS or request-signing header; MCP server rejects unsigned bridge calls
- **MCP server binding:** `127.0.0.1` or private VLAN interface only — never public-facing
- **Validator set:** permissioned consensus (IBFT 2.0 / Clique); validator keys also in HSM

---

## Priority summary

| Priority | Control |
|---|---|
| P0 | Payload privacy — hash on-chain, payload off-chain |
| P0 | Permissioned agent minting — ParticipantRegistry (banks + institutional clients; includes deployment tier) |
| P1 | Multi-sig contract governance — Gnosis Safe M-of-N |
| P1 | HSM key management for bridge signing keys |
| P2 | Bilateral flow authorization — both institutions consent |
| P2 | Institution-credentialed Tier 2 action approvers; bilateral quorum for contract execution |
| P3 | Reputation anti-gaming — participant-scoped feedback weighting |
| P3 | Regulatory audit exporter — per-institution indexed reports |
| P4 | Consortium governance contract — membership + upgrade governance |
| infra | Network hardening — static peers, mTLS, MCP loopback binding |

---

## What does not need to change

The core oracle pattern, identity registry NFT model, `ExecutionTraceLog` audit trail, MCP extension spec format (`autonomy_bounds`, `action_permits`), and the 10-layer authorization stack are all directly applicable to a cross-bank deployment. The architecture already enforces the right boundary:

- **On-chain:** identity, bindings, hashes, decisions, audit trail
- **Behind firewalls:** agent logic, inference, raw data, keys

That separation is the right foundation for inter-bank AI workflows.

---

## Internal bank deployment variant

The same architecture applies directly to **intra-bank agentic workflows** — internal departments, back-office automation, compliance pipelines — with two important differences: network placement and key management.

### Network placement

Do not deploy internal agents in the DMZ. The DMZ is designed for external-facing services; internal flows have no business there, and placing internal agents in the DMZ widens your attack surface and likely violates your own network segmentation policy.

```
Internet
   │
  DMZ              ← B2B gateway only (external agent cards, MCP proxy)
   │
Internal network   ← blockchain node, all contracts, bridges, MCP servers
   │
Secure zone        ← HSM / vault for oracle private keys
```

The private chain and all off-chain components run entirely on the internal network. Only the B2B gateway (if external agent interop is needed) sits in the DMZ.

### What changes for internal flows

| Concern | B2B cross-bank | Internal variant |
|---|---|---|
| Blockchain node | Consortium chain, DMZ-hosted | Private chain, internal network only |
| Oracle key storage | Bank HSM, bridge in DMZ | Internal vault (HashiCorp Vault, CyberArk); bridge on internal net |
| Agent minting | ParticipantRegistry multi-sig | Internal IAM / service account authorization |
| Identity integration | EIP-712 wallet binding | Supplement with internal PKI or LDAP: map employee/service account to agent NFT at registration |
| Flow initiation | External counterparty call | Internal workflow orchestrator creates the flow and populates `FlowAuthorizationRegistry` |
| Bilateral consent | Required — two banks must authorize | Not required — single organization; initiating system authorizes directly |
| Tier 2 approvers | Bank-credentialed human approvers via ParticipantRegistry | Internal role-based approvers; `ActionPermitRegistry.approveAction()` gated on internal RBAC group membership |

### What does not change

Every contract in the stack applies unchanged:

- `IdentityRegistryUpgradeable` — agent NFTs still provide auditable, non-repudiable identity
- `ActionPermitRegistry` — action-level tiering is *more* important internally where agents touch live systems
- `ExecutionTraceLog` — immutable audit trail satisfies internal compliance and change-management requirements
- `FlowAuthorizationRegistry` — scoped authorization prevents an agent invoked in one flow from acting in another
- `AutonomyBoundsRegistry` + `bounds-monitor.js` — dynamic revocation on anomaly detection applies equally to internal agents
- MCP spec format (`autonomy_bounds`, `action_permits`) — unchanged; internal MCP servers consume the same spec

The only structural simplification is dropping the consortium governance layer (`ConsortiumGovernance`, `ParticipantRegistry`, cross-bank bilateral consent) — a single organization can govern contracts with a standard internal multi-sig or admin role rather than an M-of-N cross-bank quorum.