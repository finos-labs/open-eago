# Institutional Client Onboarding — Agentic Flow Design

> **Status:** Implemented
> **Context:** Reference implementation for the ERC-8004 / MCP agentic workflow stack in a realistic cross-institutional scenario. Replaces the simple code-review/approve mock with a production-grade institutional onboarding flow.
> **Baseline:** [b2b.agentic.flow.md](b2b.agentic.flow.md) — consortium architecture and B2B controls; [concepts.md](concepts.md) — 10 governance layers

---

## Scenario

A hedge fund wishes to begin trading with a bank. The onboarding flow spans three parallel review sub-workflows (AML, Credit Risk, Legal), followed by three sequential internal setup phases (Legal Entity, Account, Product). Both institutions field autonomous agents to represent their interests. All coordination is mediated by on-chain oracle contracts on a shared permissioned consortium chain.

---

## Agent Roster

### Bank agents

| Agent | Capability | DMZ tier | Counterpart |
|---|---|---|---|
| `OnboardingOrchestrator` | `orchestrate_onboarding` | Internal (submit-only) | — |
| `AMLAgent` | `aml_review` | External (bidirectional) | `HedgeFundDocumentAgent` |
| `CreditRiskAgent` | `credit_review` | External (bidirectional) | `HedgeFundCreditNegotiatorAgent` |
| `LegalAgent` | `legal_review` | External (bidirectional) | `HedgeFundLegalAgent` |
| `LegalEntitySetupAgent` | `setup_legal_entity` | Internal (submit-only) | — |
| `AccountSetupAgent` | `setup_account` | Internal (submit-only) | — |
| `ProductSetupAgent` | `setup_products` | Internal (submit-only) | — |

### Hedge fund agents

| Agent | Capability | DMZ tier | Counterpart |
|---|---|---|---|
| `HedgeFundDocumentAgent` | `submit_documents` | External (bidirectional) | `AMLAgent`, `CreditRiskAgent` |
| `HedgeFundCreditNegotiatorAgent` | `credit_negotiation` | External (bidirectional) | `CreditRiskAgent` |
| `HedgeFundLegalAgent` | `legal_negotiation` | External (bidirectional) | `LegalAgent` |

All agents — bank and hedge fund — are registered as ERC-721 NFTs in the shared `IdentityRegistryUpgradeable`. Provenance is tracked by `ParticipantRegistry` (see [b2b.agentic.flow.md](b2b.agentic.flow.md)), which records each agent's owning institution and deployment tier.

---

## Network Topology

```
BANK
├── Internal network
│   ├── MCP servers: all bank agents (logic, model inference)
│   ├── Internal systems (KYC DB, account ledger, product config)
│   └── HSM (all oracle signing keys)
│
├── DMZ — internal tier (outbound tx submission only)
│   ├── bridges/onboarding_orchestrator_bridge.py
│   ├── bridges/client_setup_bridge.py  (handles legal entity, account, product setup)
│
├── DMZ — external tier (bidirectional: event subscription + tx submission)
│   ├── bridges/aml_bridge.py          ← listens for HF document fulfillments
│   ├── bridges/credit_risk_bridge.py  ← listens for HF credit counter-proposals
│   └── bridges/legal_bridge.py        ← listens for HF contract markups
│
└── Consortium chain RPC node (validator/peer)

HEDGE FUND
├── Internal network
│   ├── MCP servers: HedgeFundDocument, HedgeFundCreditNegotiator, HedgeFundLegal
│   └── HSM (oracle signing keys)
│
├── DMZ (bidirectional — listens for bank requests, submits responses)
│   ├── bridges/hf_document_bridge.py
│   ├── bridges/hf_credit_negotiator_bridge.py
│   └── bridges/hf_legal_bridge.py
│
└── Consortium chain RPC node (same consortium)
```

**Firewall rules:**
- Internal tier bridges: outbound to chain RPC only; no direct internet exposure
- External tier bridges: outbound to chain RPC + inbound event subscription from chain RPC; no direct IP connectivity to hedge fund
- All inter-institution communication is mediated by the chain — no direct bridge-to-bridge connections

---

## Flow State Machine

```
INITIATED
  │
  ├─── AML_PENDING ──────────────────────────────────────────┐
  │      │                                                   │
  │      ├─→ AML_DATA_REQUESTED                              │
  │      │       │ (HF Document Agent responds)              │
  │      │       └─→ AML_PENDING (resumes)                   │
  │      │                                                   │
  │      └─→ AML_IN_HUMAN_REVIEW                             │
  │               │                                          │
  │               ├─→ AML_ESCALATED → AML_IN_HUMAN_REVIEW    │ (all three
  │               │                       │                  │  run in
  │               ├─→ AML_CLEARED ─────────────────────────► │  parallel)
  │               └─→ AML_REJECTED ──────────────────────────┼─→ TERMINATED
  │                                                          │
  ├─── CREDIT_PENDING ───────────────────────────────────────┤
  │      │                                                   │
  │      ├─→ CREDIT_DATA_REQUESTED                           │
  │      │       │ (HF Document Agent responds)              │
  │      │       └─→ CREDIT_PENDING (resumes)                │
  │      │                                                   │
  │      ├─→ CREDIT_NEGOTIATING                              │
  │      │       │ (HF Credit Negotiator counter-proposes)   │
  │      │       └─→ CREDIT_PENDING (resumes)                │
  │      │                                                   │
  │      └─→ CREDIT_IN_HUMAN_REVIEW                          │
  │               │                                          │
  │               ├─→ CREDIT_ESCALATED → CREDIT_IN_HUMAN_REVIEW
  │               ├─→ CREDIT_APPROVED ─────────────────────► │
  │               └─→ CREDIT_REJECTED ────────────────────── ┼─→ TERMINATED
  │                                                          │
  └─── LEGAL_PENDING ────────────────────────────────────────┘
         │
         ├─→ LEGAL_DRAFT_ISSUED
         │       │ (HF Legal Agent submits markup)
         │       └─→ LEGAL_NEGOTIATING (round N+1...)
         │
         └─→ LEGAL_IN_HUMAN_REVIEW
                 │
                 ├─→ LEGAL_ESCALATED → LEGAL_IN_HUMAN_REVIEW
                 ├─→ LEGAL_EXECUTED ──────────────────────► ┐
                 └─→ LEGAL_REJECTED ─────────────────────── ┼─→ TERMINATED
                                                            │
                              [AML_CLEARED + CREDIT_APPROVED + LEGAL_EXECUTED]
                                                            │
                                                    LEGAL_ENTITY_SETUP
                                                            │ complete
                                                    ACCOUNT_SETUP
                                                            │ complete
                                                    PRODUCT_SETUP
                                                            │ complete
                                                    READY_TO_TRANSACT
```

**TERMINATED** is a terminal absorbing state. Any rejected sub-flow calls `OnboardingRegistry.terminate(flowId, reason)`. All other oracle contracts check `onlyActiveFlow(flowId)` before accepting any further action, blocking the remaining sub-flows immediately.

---

## Oracle Contract Inventory

### `OnboardingRegistry`

Central state machine. Owns the phase bitmask and the termination mechanism.

```
State
  mapping(bytes32 → OnboardingFlow) flows
    struct OnboardingFlow {
      address initiator          // hedge fund wallet
      uint8   phaseBitmask       // bits 0–5 track phase completion
      bool    terminated
      bytes   terminationReason
    }

Constants (bitmask positions)
  AML_CLEARED         = 0x01
  CREDIT_APPROVED     = 0x02
  LEGAL_EXECUTED      = 0x04
  ENTITY_SETUP_DONE   = 0x08
  ACCOUNT_SETUP_DONE  = 0x10
  PRODUCT_SETUP_DONE  = 0x20
  ALL_REVIEWS_DONE    = 0x07
  ALL_PHASES_DONE     = 0x3F

Functions
  initiateOnboarding(clientId)   → flowId    // emits OnboardingInitiated
  setPhaseComplete(flowId, bit)              // called by sub-flow oracles only
  terminate(flowId, reason)                  // called by any sub-flow oracle on rejection
  isActive(flowId)               → bool

Events
  OnboardingInitiated(flowId, clientId, initiator, timestamp)
  PhaseCompleted(flowId, bit, timestamp)
  OnboardingTerminated(flowId, reason, timestamp)
  ReadyToTransact(flowId, clientId, timestamp)
```

`setPhaseComplete` is access-controlled: only the registered oracle contracts for each phase may call it (set at deploy time). When `phaseBitmask == ALL_PHASES_DONE`, it emits `ReadyToTransact`.

---

### `AMLOracle`

```
State
  mapping(bytes32 → AMLRequest) requests
    struct AMLRequest {
      bytes32 flowId
      uint256 clientAgentId      // HF document agent NFT id
      uint256 bankAgentId        // bank AML agent NFT id
      uint8   status             // None|Pending|DataRequested|InHumanReview|Escalated|Cleared|Rejected
      bytes32 dataRequestSpec    // keccak256 of requested document set
      uint8   dataRequestRound
      bytes32 resultHash         // keccak256 of screening result (off-chain)
      uint256 createdAt
    }

Functions
  requestAMLReview(flowId, bankAgentId, clientAgentId)  → requestId  // bank initiates; emits AMLReviewRequested
  requestClientData(requestId, bankAgentId, dataSpecHash)             // AML agent; emits DataRequested
  fulfillDataRequest(requestId, clientAgentId, dataHash, cardHash_)   // HF Document Agent; emits DataFulfilled
  submitRecommendation(requestId, bankAgentId, resultHash, cardHash_) // AML agent; → InHumanReview; emits InHumanReview
  escalate(requestId, bankAgentId, reason)                            // AML agent; → Escalated; emits Escalated
  clear(requestId, bankAgentId)                                       // human approver (Tier 2); emits AMLCleared
  reject(requestId, bankAgentId, reason)                              // human approver (Tier 2); emits AMLRejected → terminate

Events
  AMLReviewRequested(requestId, flowId, bankAgentId, clientAgentId, timestamp)
  DataRequested(requestId, flowId, dataSpecHash, round, timestamp)
  DataFulfilled(requestId, flowId, dataHash, submittingAgentId, timestamp)
  InHumanReview(requestId, flowId, timestamp)
  Escalated(requestId, flowId, reason, timestamp)
  AMLCleared(requestId, flowId, bankAgentId, timestamp)
  AMLRejected(requestId, flowId, reason, bankAgentId, timestamp)
```

`clear` and `reject` are Tier 2 actions in `ActionPermitRegistry`. The `onlyRegisteredOracle` modifier verifies the bank AML agent identity. `fulfillDataRequest` verifies the hedge fund document agent identity via `ParticipantRegistry`.

---

### `CreditRiskOracle`

Same lifecycle structure as `AMLOracle` with one addition: the credit negotiation loop.

```
Additional functions
  proposeTerms(requestId, termsHash)               // CreditRisk agent; → negotiating
  submitCounterProposal(requestId, proposalHash)   // HF Credit Negotiator agent; emits CounterProposed
  acceptTerms(requestId, agreedTermsHash)          // CreditRisk agent; → inReview
  submitRecommendation(requestId, resultHash)      // → inReview
  approve(requestId)                               // human approver (Tier 2)
  reject(requestId, reason)                        // human approver (Tier 2) → terminate

Events
  TermsProposed(requestId, flowId, termsHash, round, timestamp)
  CounterProposed(requestId, flowId, proposalHash, agentId, timestamp)
  TermsAgreed(requestId, flowId, agreedTermsHash, timestamp)
  CreditApproved(requestId, flowId, agentId, timestamp)
  CreditRejected(requestId, flowId, reason, agentId, timestamp)
```

---

### `LegalOracle`

Iterative negotiation. Each round is a hop in `ExecutionTraceLog`. Contract version hashes are stored per round, creating an immutable audit trail of the negotiation history.

```
State
  mapping(bytes32 → LegalRequest) requests
    struct LegalRequest {
      bytes32 flowId
      uint8   status
      uint8   roundNumber
      mapping(uint8 → bytes32) contractVersionHash   // hash per round
    }

Functions
  requestLegalReview(flowId, bankAgentId, clientAgentId)             → requestId
  issueDraft(requestId, bankAgentId, contractHash, cardHash_)        // LegalAgent; all rounds; emits DraftIssued
  submitMarkup(requestId, clientAgentId, markupHash, cardHash_)      // HF Legal Agent; emits MarkupSubmitted
  submitRecommendation(requestId, bankAgentId, finalHash, cardHash_) // LegalAgent; → InHumanReview
  escalate(requestId, bankAgentId, reason)
  approveBankSide(requestId, bankAgentId)            // bank human approver (Tier 2)
  approveClientSide(requestId, clientAgentId)        // HF human approver (Tier 2)
  execute(requestId)                                 // callable by any once both sides approved; emits ContractExecuted
  reject(requestId, bankAgentId, reason)             // human approver (Tier 2) → terminate

Events
  DraftIssued(requestId, flowId, contractHash, round, timestamp)
  MarkupSubmitted(requestId, flowId, markupHash, round, agentId, timestamp)
  InHumanReview(requestId, flowId, round, timestamp)
  Escalated(requestId, flowId, reason, timestamp)
  ContractExecuted(requestId, flowId, finalContractHash, timestamp)
  LegalRejected(requestId, flowId, reason, timestamp)
```

`execute` requires Tier 2 approval from **both** a bank approver and a hedge fund approver — the first multi-institution approval quorum in the stack. `ActionPermitRegistry` is extended to support a `requiredParticipants[]` list per action for this case.

---

### `ClientSetupOracle`

Handles all three setup phases sequentially in a single contract. Each phase is gated on the previous one completing and on `OnboardingRegistry.phaseBitmask` reflecting all reviews done.

```
Functions
  setupLegalEntity(flowId, agentId, entitySpecHash, cardHash_)   // gated: ALL_REVIEWS_DONE; emits LegalEntitySetupComplete
  setupAccount(flowId, agentId, accountSpecHash, cardHash_)      // gated: ENTITY_SETUP_DONE; emits AccountSetupComplete
  setupProducts(flowId, agentId, productSpecHash, cardHash_)     // gated: ACCOUNT_SETUP_DONE; emits ProductSetupComplete

Events
  LegalEntitySetupStarted(flowId, agentId, timestamp)
  LegalEntitySetupComplete(flowId, entitySpecHash, agentId, timestamp)
  AccountSetupStarted(flowId, agentId, timestamp)
  AccountSetupComplete(flowId, accountSpecHash, agentId, timestamp)
  ProductSetupStarted(flowId, agentId, timestamp)
  ProductSetupComplete(flowId, productSpecHash, agentId, timestamp)
```

Each `setup*` function calls `onboardingRegistry.setPhaseComplete(flowId, bit)` on completion. `setupProducts` setting `PRODUCT_SETUP_DONE` triggers `ReadyToTransact`.

---

## Key Patterns

### Async data request / resume

AML and Credit Risk can suspend mid-flow to request client documents. The oracle emits `DataRequested(requestId, flowId, dataSpecHash, round)` and sets status to `DATA_REQUESTED`. The hedge fund bridge picks up the event, routes it to the relevant MCP server (document agent or credit negotiator), and the agent calls `fulfillDataRequest` or `submitCounterProposal` on-chain. The bank bridge then picks up the fulfillment event and routes it back to the bank MCP server, resuming the review.

This is a two-bridge relay pattern — neither bridge holds state; the oracle contract is the synchronization point.

### Iterative legal negotiation

Each `issueDraft` / `submitMarkup` / `issueRevisedDraft` cycle increments `roundNumber` and stores the `contractVersionHash` for that round. Every round is recorded as a hop in `ExecutionTraceLog`, making the full negotiation history tamper-evident. Loop detection in `ExecutionTraceLog` is configured with a generous `maxHopsPerTrace` for legal flows to accommodate realistic negotiation depth, but with loop detection enabled to catch pathological cycling.

### Human-in-the-loop via ActionPermitRegistry Tier 2

Final decisions (`clear`, `approve`, `execute`, `reject`) are Tier 2 actions. The agent submits its recommendation on-chain, the oracle enters `IN_HUMAN_REVIEW` state, and execution is paused. A registered bank approver (from `ParticipantRegistry.approvers`) calls `ActionPermitRegistry.approveAction(flowId, agentId, actionType)`. Only then does the oracle allow the `clear` / `approve` / `execute` / `reject` call to proceed. The specific invocation is paused — not the entire flow — so AML review pausing for human approval does not block the parallel credit and legal sub-flows.

### Escalation path

Any review oracle can call `escalate(requestId, reason)`. This changes the required approver set to a senior approver group (a separate address set in `ParticipantRegistry`). If the senior approver also rejects, the oracle calls `onboardingRegistry.terminate(flowId, reason)` and emits its rejection event. Escalation is itself a Tier 1 action (reversible — it elevates, not terminates).

### Termination propagation

`OnboardingRegistry.terminate(flowId, reason)` sets `terminated = true` and emits `OnboardingTerminated`. Every oracle modifier `onlyActiveFlow(flowId)` checks this flag and reverts with `"onboarding terminated"` if set. This blocks all further sub-flow actions atomically — a rejection in one sub-flow freezes the entire onboarding with no cleanup transactions required.

### Sequential setup gating (on-chain)

```solidity
// In ClientSetupOracle
function setupAccount(bytes32 flowId, bytes calldata accountSpec) external onlyRegisteredOracle(agentId) {
    require(onboardingRegistry.isActive(flowId), "onboarding terminated");
    require(
        onboardingRegistry.phaseBitmask(flowId) & ALL_REVIEWS_DONE == ALL_REVIEWS_DONE,
        "reviews not complete"
    );
    require(
        onboardingRegistry.phaseBitmask(flowId) & ENTITY_SETUP_DONE == ENTITY_SETUP_DONE,
        "legal entity setup not complete"
    );
    // ...
}
```

No off-chain coordination is required for setup sequencing — the chain enforces the order.

---

## How the 10 Governance Layers Apply

| Layer | Contract | Application in this flow |
|---|---|---|
| 1. Identity | `IdentityRegistryUpgradeable` | All 10 agents (bank + HF) are ERC-721 NFTs; `onlyRegisteredOracle` verifies wallet + oracle binding on every fulfillment |
| 2. Tracing | `ExecutionTraceLog` | Full hop log across all sub-flows and both institutions; negotiation rounds each recorded as a hop; `traceId = flowId` |
| 3. Flow authorization | `FlowAuthorizationRegistry` | AML agent cannot act in legal oracle; HF legal agent cannot act in AML oracle; setup agents cannot act before reviews are authorized |
| 4. Reputation | `ReputationGate` | AML agents require minimum track record (`aml_review` capability); legal agents require execution history; new agents blocked until proven |
| 5. Prompt governance | `PromptRegistry` | AML screening prompt template hash committed on-chain; legal draft template versioned; sanctions list query prompt locked |
| 6. Dataset control | `DatasetRegistry` | AML screening datasets (sanctions lists, PEP lists) approved per flow; credit assessment models registered; HF cannot inject unapproved datasets |
| 7. Autonomy bounding | `AutonomyBoundsRegistry` | Anomalous AML rejection rates trigger `disableTool`; legal agent with high markup-rejection rate gets revoked; bounds-monitor watches all oracles |
| 8. Flow anomaly detection | `ExecutionTraceLog` (on-chain) + `bounds_monitor.py` | Max hops configured per sub-flow type; loop detection catches circular negotiation; burst detection catches runaway data requests; timeout detection catches stalled reviews |
| 9. Card integrity | `IdentityRegistryUpgradeable` | Bridges verify `cardHash` at startup; oracle contracts enforce it per-fulfillment via `_checkCardHash` — a tampered agent card causes the fulfillment transaction to revert |
| 10. Action-level authorization | `ActionPermitRegistry` | `clear`, `approve`, `execute`, `reject` are Tier 2 (human sign-off); `request_data`, `issue_draft`, `escalate` are Tier 1; `setup_*` are Tier 1; `terminate` is Tier 2 |

---

## Action Tier Classification

| Action | Oracle | Tier | Rationale |
|---|---|---|---|
| `aml:request_client_data` | AMLOracle | 1 — reversible | Requesting more info; no irreversible consequence |
| `aml:submit_recommendation` | AMLOracle | 1 — reversible | Internal; human review follows |
| `aml:escalate` | AMLOracle | 1 — reversible | Elevates, does not terminate |
| `aml:clear` | AMLOracle | 2 — destructive / human sign-off | Grants onboarding progression; cannot be undone in-flow |
| `aml:reject` | AMLOracle | 2 — destructive / human sign-off | Terminates onboarding |
| `credit:propose_terms` | CreditRiskOracle | 1 — reversible | Opens negotiation |
| `credit:approve` | CreditRiskOracle | 2 — destructive / human sign-off | Commits credit limit |
| `credit:reject` | CreditRiskOracle | 2 — destructive / human sign-off | Terminates onboarding |
| `legal:issue_draft` | LegalOracle | 1 — reversible | Opens negotiation round |
| `legal:submit_markup` | LegalOracle | 1 — reversible | HF response; counter-party action |
| `legal:execute_contract` | LegalOracle | 2 — destructive / **bilateral** human sign-off | Legally binding; requires approvers from both institutions |
| `legal:reject` | LegalOracle | 2 — destructive / human sign-off | Terminates onboarding |
| `setup:setup_legal_entity` | ClientSetupOracle | 1 — reversible | Internal system write; reversible by ops |
| `setup:setup_account` | ClientSetupOracle | 1 — reversible | Same |
| `setup:setup_products` | ClientSetupOracle | 1 — reversible | Same |
| `onboarding:terminate` | OnboardingRegistry | 2 — destructive | Absorbing state; no recovery without new flow |

`legal:execute_contract` is the only action requiring a **bilateral** Tier 2 quorum — one approver from the bank and one from the hedge fund. `ActionPermitRegistry` supports a `requiredParticipants[]` list per action type for this purpose.

---

## Off-Chain Component Map

All components are in `agents_implementation_py/` (Python, web3.py + LangChain).

| File | Institution | DMZ tier | Role |
|---|---|---|---|
| `servers/aml_server.py` | Bank | Internal | AML screening MCP server |
| `servers/credit_risk_server.py` | Bank | Internal | Credit assessment MCP server |
| `servers/legal_server.py` | Bank | Internal | Legal negotiation MCP server |
| `servers/onboarding_orchestrator_server.py` | Bank | Internal | Flow initiation MCP server |
| `servers/client_setup_server.py` | Bank | Internal | All 3 setup phases MCP server |
| `bridges/aml_bridge.py` | Bank | DMZ external | Bidirectional; listens for HF document fulfillments |
| `bridges/credit_risk_bridge.py` | Bank | DMZ external | Bidirectional; listens for HF counter-proposals |
| `bridges/legal_bridge.py` | Bank | DMZ external | Bidirectional; listens for HF markups |
| `bridges/onboarding_orchestrator_bridge.py` | Bank | DMZ internal | Submit-only; runs LangGraph `StateGraph` |
| `bridges/client_setup_bridge.py` | Bank | DMZ internal | Submit-only |
| `servers/hf_document_server.py` | Hedge fund | Internal | Document assembly MCP server |
| `servers/hf_credit_negotiator_server.py` | Hedge fund | Internal | Credit negotiation MCP server |
| `servers/hf_legal_server.py` | Hedge fund | Internal | Legal markup MCP server |
| `bridges/hf_document_bridge.py` | Hedge fund | DMZ external | Listens for bank `DataRequested` events |
| `bridges/hf_credit_negotiator_bridge.py` | Hedge fund | DMZ external | Listens for bank `TermsProposed` events |
| `bridges/hf_legal_bridge.py` | Hedge fund | DMZ external | Listens for bank `DraftIssued` events |

The orchestrator bridge runs a LangGraph `StateGraph` (see `graph/`) modelling the entire onboarding flow as explicit typed states and conditional edges.

---

## ParticipantRegistry

This flow requires `BankRegistry` (from [b2b.agentic.flow.md](b2b.agentic.flow.md)) to be generalised to `ParticipantRegistry`, since both banks and institutional clients are first-class registered participants.

```
struct Participant {
  bytes32          participantId
  ParticipantType  participantType    // BANK | CLIENT
  DeploymentTier   defaultAgentTier   // BANK_INTERNAL | BANK_EXTERNAL | CLIENT_EXTERNAL
  address[]        approvers          // Tier 2 standard approvers
  address[]        seniorApprovers    // Tier 2 escalation approvers
  bool             active
}

enum ParticipantType  { BANK, CLIENT }
enum DeploymentTier   { BANK_INTERNAL, BANK_EXTERNAL, CLIENT_EXTERNAL }

Functions
  registerParticipant(participantId, participantType, defaultAgentTier, approvers[], seniorApprovers[])
  participantOf(agentId)         → Participant
  isApprover(msg.sender)         → bool
  isSeniorApprover(msg.sender)   → bool
  isApprovedMinter(address)      → bool   // gates IdentityRegistry.register()
```

The `defaultAgentTier` field makes the deployment topology machine-readable: ops tooling reads it to determine which firewall rules and bridge launch configuration apply to each agent.

---

## Relationship to B2B Controls

All B2B additional controls from [b2b.agentic.flow.md](b2b.agentic.flow.md) apply to this flow. Priority order for implementation:

| Control | Relevance to onboarding flow |
|---|---|
| P0: Payload privacy | AML screening results, credit terms, legal contract text must never appear on-chain in plaintext; `payloadHash` only |
| P0: ParticipantRegistry + permissioned minting | Gates which institutions can register agents; prevents rogue agent injection |
| P1: Multi-sig contract governance | Governance of `OnboardingRegistry`, `AMLOracle`, `CreditRiskOracle`, `LegalOracle` parameter changes |
| P1: HSM bridge signing | All 10 oracle bridges sign via HSM; no raw key material in bridge processes |
| P2: Bilateral flow authorization | `FlowAuthorizationRegistry` requires both bank and HF to authorize their agents before the flow can proceed |
| P2: Bank-credentialed Tier 2 approvers | `aml:clear`, `credit:approve`, `legal:execute_contract` require credentialed human approvers via `ParticipantRegistry` |
| P3: Reputation anti-gaming | AML and credit feedback from HF agents cannot be self-serving; scoped by `participantId` |
| P3: Regulatory audit exporter | Per-institution indexing of all onboarding hops, decisions, and document hashes for compliance reporting |
| P4: Consortium governance | `ConsortiumGovernance` M-of-N voting governs adding/removing member institutions, changing shared parameters, and emergency pause of cross-bank flows |
