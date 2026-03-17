# MCP-8004 Enterprise Agentic Workflow Framework

An R&D development project / development environment for an **enterprise agentic workflow framework** built on two 
complementary 
standards:

- **ERC-8004** — on-chain agent identity registry. Each agent is an ERC-721 NFT with a verified wallet, a bound oracle contract, and arbitrary capability metadata.
- **MCP (Model Context Protocol)** — agent invocation standard. Each agent exposes tools, resources, and prompts over HTTP/JSON-RPC 2.0.

The two standards are linked: every agent card points to an MCP spec, every MCP spec drives a Solidity oracle contract, and the identity registry binds the agent identity to that oracle in a single transaction.

See [`paper/paper.md`](./paper/paper.md) for the complete technical reference and [`design/concepts.md`](./design/concepts.md) as the index of all R&D design documents.

---

## Architecture overview

```
Agent Card (JSON)
      │  mcpSpec →
      ▼
MCP Specification (JSON)
      │
      ├──▶  Solidity Oracle Contract   on-chain request / response
      ├──▶  MCP Server                 off-chain tool / resource / prompt implementation
      └──▶  Oracle Bridge              event watcher + fulfillment tx submitter
```

Three-tier cross-institutional onboarding topology:

```
BANK A ──TX──► AMLOracle / CreditRiskOracle / LegalOracle / ClientSetupOracle ◄──TX── HF CLIENT
         ◄─EVENT──────────────── OnboardingRegistry ──────────────────────EVENT──►
                                   ExecutionTraceLog
```

The `OnboardingRegistry` tracks a six-bit phase bitmask per flow (AML cleared, credit assessed, legal executed, legal entity set up, account set up, products set up). Each oracle contract advances the bitmask when a phase completes; `ClientSetupOracle` gates each setup step on the relevant prior phase bit.

---

## Project structure

```
botman_8004/
├── agents/                                    # 10 agent card JSON files
│   ├── bank-aml-agent.json                    #   BankAMLAgent           — port 8010
│   ├── bank-credit-risk-agent.json            #   BankCreditRiskAgent    — port 8011
│   ├── bank-legal-agent.json                  #   BankLegalAgent         — port 8012
│   ├── bank-onboarding-orchestrator.json      #   OnboardingOrchestrator — port 8013
│   ├── bank-legal-entity-setup-agent.json     #   LegalEntitySetupAgent  — port 8014
│   ├── bank-account-setup-agent.json          #   AccountSetupAgent      — port 8015
│   ├── bank-product-setup-agent.json          #   ProductSetupAgent      — port 8016
│   ├── hf-document-agent.json                 #   HFDocumentAgent        — port 8020
│   ├── hf-credit-negotiator-agent.json        #   HFCreditNegotiator     — port 8021
│   ├── hf-legal-agent.json                    #   HFLegalAgent           — port 8022
│   └── mcp/                                   #   8 MCP spec files
│       ├── aml-review.mcp.json
│       ├── credit-risk.mcp.json
│       ├── legal-review.mcp.json
│       ├── onboarding-orchestrator.mcp.json
│       ├── client-setup.mcp.json
│       ├── hf-document.mcp.json
│       ├── hf-credit-negotiator.mcp.json
│       └── hf-legal.mcp.json
│
├── agents_implementation_py/                  # Off-chain MCP servers + oracle bridges (Python)
│   ├── servers/
│   │   ├── aml_server.py                      #   MCP server — AML screening
│   │   ├── credit_risk_server.py              #   MCP server — credit risk assessment
│   │   ├── legal_server.py                    #   MCP server — legal document review
│   │   ├── onboarding_orchestrator_server.py  #   MCP server — flow orchestration
│   │   ├── client_setup_server.py             #   MCP server — legal entity / account / product setup
│   │   ├── hf_document_server.py              #   MCP server — HF document submission
│   │   ├── hf_credit_negotiator_server.py     #   MCP server — HF credit term negotiation
│   │   └── hf_legal_server.py                 #   MCP server — HF legal markup / approval
│   ├── bridges/
│   │   ├── aml_bridge.py                      #   Bridge: ReviewRequested → fulfillReview
│   │   ├── credit_risk_bridge.py              #   Bridge: AssessmentRequested → fulfillAssessment / proposeTerms
│   │   ├── legal_bridge.py                    #   Bridge: DraftRequested → submitDraft / approveBankSide
│   │   ├── onboarding_orchestrator_bridge.py  #   Bridge: REST POST /initiate → OnboardingRegistry.initiate()
│   │   ├── client_setup_bridge.py             #   Bridge: PhaseCompleted → setupLegalEntity / setupAccount / setupProducts
│   │   ├── hf_document_bridge.py              #   Bridge: DocumentRequested → submitDocumentHash
│   │   ├── hf_credit_negotiator_bridge.py     #   Bridge: TermsProposed → submitCounterProposal / acceptTerms
│   │   └── hf_legal_bridge.py                 #   Bridge: MarkupRequested → submitMarkup / approveClientSide
│   ├── shared/
│   │   ├── server_base.py                     #   FastMCP factory + @suspended_when_revoked decorator
│   │   ├── bridge_base.py                     #   Bridge bootstrap + governance preflight
│   │   ├── vault_signer.py                    #   LocalSigner / VaultSigner — local or HSM backend
│   │   └── bounds_monitor_client.py           #   Reads bounds-state.json, POSTs to :9090/report
│   ├── graph/                                 #   LangGraph onboarding state machine
│   ├── launch_servers.py                      #   Spawns one server process per agent card
│   └── launch_bridges.py                      #   Spawns all 8 bridge processes
│
├── contracts/
│   ├── oracles/
│   │   ├── AMLOracle.sol                      #   Request/response lifecycle for AML review
│   │   ├── CreditRiskOracle.sol               #   Credit assessment + term negotiation
│   │   ├── LegalOracle.sol                    #   Draft / markup / bilateral approval lifecycle
│   │   ├── ClientSetupOracle.sol              #   Sequential setup: legalEntity → account → products
│   │   └── MockOracle.sol                     #   Minimal stub for unit tests
│   └── registries/
│       ├── IdentityRegistryUpgradeable.sol    #   ERC-8004: ERC-721 identity + oracle binding (UUPS)
│       ├── ParticipantRegistry.sol            #   Institution identity; permissioned minting
│       ├── OnboardingRegistry.sol             #   Phase bitmask + termination per flow
│       ├── FlowAuthorizationRegistry.sol      #   Per-flow agent authorization policy
│       ├── ReputationRegistry.sol             #   Reputation scores keyed by agent NFT ID
│       ├── ReputationGate.sol                 #   Min-score + min-count quality gate
│       ├── PromptRegistry.sol                 #   Prompt template governance (keccak256 hashes)
│       ├── DatasetRegistry.sol                #   Dataset hash governance
│       ├── AutonomyBoundsRegistry.sol         #   Dynamic tool enable/disable by monitor
│       ├── ActionPermitRegistry.sol           #   Action-level authorization (four tiers)
│       ├── ExecutionTraceLog.sol              #   Distributed tracing: ordered hops per traceId
│       ├── ConsortiumGovernance.sol           #   M-of-N member proposals + emergency pause
│       ├── MockMultiSig.sol                   #   M-of-N threshold multi-sig for testing
│       └── I*.sol                             #   Interfaces consumed by oracle contracts
│
├── design/
│   ├── concepts.md                            #   Index of all R&D concepts  ← start here
│   ├── architecture.proposal.md              #   Full ERC-8004 + MCP design rationale
│   ├── 8004.refactor.md                      #   Identity registry refactor notes
│   ├── mcp.extension.md                      #   MCP extensions (autonomy bounds, action permits, card hash)
│   ├── b2b.agentic.flow.md                   #   B2B controls (P0–P4)
│   └── onboarding.flow.md                    #   Onboarding flow walkthrough
│
├── paper/                                     # Research paper + figures
│   └── paper.md
│
├── test/                                      # Hardhat test suite (17 test files)
│
├── hardhat.config.js
└── package.json
```

---

## Quick start

> Requires: **Node.js >= 18** (Hardhat toolchain), **Python >= 3.11** (off-chain layer)

### 1 — Install dependencies

```bash
npm install
cd agents_implementation_py && pip install -e . && cd ..
```

### 2 — Compile contracts

```bash
npx hardhat compile
```

> Hardhat config: Solidity 0.8.22, optimizer runs: 1, `viaIR: true` (required for deep stack in oracle fulfillment functions).

### 3 — Start Hardhat node (separate terminal)

```bash
npx hardhat node
```

### 4 — Deploy contracts

Deploy scripts for the full contract suite are in progress. To exercise all contracts in-process against a fresh in-process Hardhat node, run the test suite:

```bash
npm test
```

All 17 test files deploy the contracts they need via Hardhat fixtures — no persistent node required.

### 5 — Register agents on-chain

Agent registration uses `register(agentURI, metadata[], oracleAddress)` — a single transaction per bank agent that records identity, card URI, capability metadata, and oracle binding together. Client agents omit the `oracleAddress` argument (they are callers, not fulfiller oracles).

See the test fixtures in `test/AMLOracle.test.js`, `test/OnboardingRegistry.test.js`, etc. for reference registration patterns.

### 6 — Launch MCP servers

```bash
# Foreground (Ctrl-C stops all)
python agents_implementation_py/launch_servers.py
```

The launcher reads every `.json` file in `agents/`, maps each capability to a server module, and spawns one process per card. Capability → server mapping:

| Capability | Server |
|---|---|
| `aml-review` | `aml_server.py` |
| `credit-risk` | `credit_risk_server.py` |
| `legal-review` | `legal_server.py` |
| `onboarding` | `onboarding_orchestrator_server.py` |
| `client-setup` | `client_setup_server.py` |
| `hf-document` | `hf_document_server.py` |
| `hf-credit-negotiator` | `hf_credit_negotiator_server.py` |
| `hf-legal` | `hf_legal_server.py` |

### 7 — Launch oracle bridges

```bash
python agents_implementation_py/launch_bridges.py \
  --rpc                  http://127.0.0.1:8545 \
  --privkey              0x<OraclePrivateKey> \
  --onboarding-registry  0x... \
  --aml-contract         0x... \
  --credit-contract      0x... \
  --legal-contract       0x...
```

> `--setup-contract` is optional; `client_setup_bridge` is skipped if not provided.

Optional flags (also readable from environment variables):

| Flag | Env var | Purpose |
|---|---|---|
| `--identity-registry` | `IDENTITY_REGISTRY_ADDRESS` | Card hash startup check |
| `--autonomy-bounds` | `AUTONOMY_BOUNDS_ADDRESS` | Tool enable/disable governance |
| `--action-permit` | `ACTION_PERMIT_ADDRESS` | Action-level pre-flight |
| `--trace-log` | `TRACE_LOG_ADDRESS` | Flow anomaly policy |

`VaultSigner` (`shared/vault_signer.py`) supports both a local private key and a HashiCorp Vault (HSM) backend. Set `VAULT_ADDR` + `VAULT_TOKEN` + `VAULT_KEY_NAME` to use Vault.

---

## Agent cards

Each file in `agents/` describes one agent. The `capabilities` field drives which server script is spawned; `endpoint` provides the port; `mcpSpec` links to the MCP specification.

```json
{
  "name": "BankAMLAgent",
  "description": "Bank AML screening agent. Performs sanctions/PEP screening for institutional client onboarding.",
  "capabilities": ["aml_review"],
  "institution": "ACME_BANK",
  "dmzTier": "BANK_EXTERNAL",
  "endpoint": "http://localhost:8010",
  "mcpSpec": "./mcp/aml-review.mcp.json"
}
```

To **add an agent**: create a new `.json` file in `agents/` with a unique port and restart the launcher.
To **remove an agent**: delete its `.json` file and restart.

---

## MCP server API

Every agent server exposes:

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Agent card JSON |
| `GET` | `/.well-known/agent` | Agent card JSON (MCP / A2A discovery) |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 endpoint |

### JSON-RPC methods

| Method | Description |
|---|---|
| `initialize` | MCP handshake — returns server capabilities |
| `tools/list` | Lists all tools with name, description, inputSchema |
| `tools/call` | Invokes a named tool with arguments |
| `resources/list` | Lists available resource URIs |
| `resources/read` | Reads a resource by URI |
| `prompts/list` | Lists available prompts |
| `prompts/get` | Renders a prompt template with supplied arguments |

When a tool is suspended by `AutonomyBoundsRegistry`, `tools/list` includes `x_suspended: true` + `x_suspension_reason`, and `tools/call` returns JSON-RPC error `-32001`.

### Tools by agent group

**Bank side:**

| Agent | Key tools |
|---|---|
| `aml-server.js` | `requestReview`, `fulfillReview`, `requestData`, `submitData` |
| `credit-risk-server.js` | `requestAssessment`, `fulfillAssessment`, `proposeTerms`, `submitCounterProposal`, `acceptTerms` |
| `legal-server.js` | `requestDraft`, `submitDraft`, `submitMarkup`, `approveBankSide`, `execute` |
| `onboarding-orchestrator-server.js` | `initiateOnboarding`, `getFlowStatus`, `terminateFlow` |
| `client-setup-server.js` | `setupLegalEntity`, `setupAccount`, `setupProducts` |

**HF (Hedge Fund) side:**

| Agent | Key tools |
|---|---|
| `hf-document-server.js` | `requestDocument`, `submitDocumentHash` |
| `hf-credit-negotiator-server.js` | `submitCounterProposal`, `acceptTerms` |
| `hf-legal-server.js` | `submitMarkup`, `approveClientSide` |

### Example requests

```bash
# Agent card
curl http://localhost:8010/

# List tools
curl -X POST http://localhost:8010/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Request AML review
curl -X POST http://localhost:8010/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"requestReview","arguments":{"traceId":"0xabc..."}}}'
```

---

## Off-chain components

A parallel Python implementation (`agents_implementation_py/`) ships alongside the Node.js layer. It uses LangChain LCEL chains (`ChatPromptTemplate | ChatOpenAI`) for real LLM inference, web3.py AsyncWeb3 for event watching, and a LangGraph StateGraph for the onboarding orchestrator. Both layers consume the same on-chain contracts, agent cards, and MCP spec files. The Python layer targets ports 8010–8022 by default and supports `--smoke-test` mode (ports 8110+) for parallel validation.

---

## Oracle bridges

Each oracle contract has a corresponding off-chain bridge that closes the on-chain ↔ off-chain loop:

| Bridge | Watches | Submits |
|---|---|---|
| `aml-bridge.js` | `ReviewRequested` | `fulfillReview` |
| `credit-risk-bridge.js` | `AssessmentRequested` | `fulfillAssessment` / `proposeTerms` |
| `legal-bridge.js` | `DraftRequested` | `submitDraft` / `approveBankSide` |
| `onboarding-orchestrator-bridge.js` | REST POST `/initiate` | `OnboardingRegistry.initiate()` |
| `client-setup-bridge.js` | `PhaseCompleted` | `setupLegalEntity` / `setupAccount` / `setupProducts` |
| `hf-document-bridge.js` | `DocumentRequested` | `submitDocumentHash` |
| `hf-credit-negotiator-bridge.js` | `TermsProposed` | `submitCounterProposal` / `acceptTerms` |
| `hf-legal-bridge.js` | `MarkupRequested` | `submitMarkup` / `approveClientSide` |

All bridges import `bridge-base.js` for shared bootstrap: provider/signer setup, governance pre-flight checks (`FlowAuthorizationRegistry`, `ReputationGate`, `PromptRegistry`), and the `callMcpTool` helper.

The bridge passes the ERC-8004 `agentId` on every fulfillment call. The oracle verifies via `IIdentityRegistry` that `msg.sender == agentWallet` and `oracleAddress == address(this)` — registration in the identity registry is the oracle authorization. No separate whitelist needed.

---

## Smart contracts

### Nine-layer authorization stack

Every oracle fulfillment passes through up to nine authorization layers:

| Layer | Contract | Question answered |
|---|---|---|
| 1 | `IdentityRegistryUpgradeable` + `onlyRegisteredOracle` | Does this agent exist, and is this wallet calling its bound oracle? |
| 2 | `FlowAuthorizationRegistry` | Is this agent authorized to act in **this specific flow**? |
| 3 | `ReputationGate` | Has this agent earned sufficient reputation for this capability? |
| 4 | `PromptRegistry` | Is the agent using the current approved prompt template? |
| 5 | `DatasetRegistry` | Is the agent using an approved dataset? |
| 6 | `AutonomyBoundsRegistry` | Is this tool currently enabled (not suspended by monitor)? |
| 7 | `ExecutionTraceLog` | Does this hop violate loop or max-hop policy? |
| 8 | `IdentityRegistryUpgradeable` (`cardHash`) | Does the live agent card match the on-chain registered hash? |
| 9 | `ActionPermitRegistry` | Is this specific action permitted for this flow and agent (tier check)? |

All layers are opt-in: each returns `true` (permissive) when not configured, so existing flows are unaffected by layers they do not enable.

---

### `IdentityRegistryUpgradeable` (ERC-8004)

- ERC-721 token — one NFT per registered agent
- UUPS upgradeable (OpenZeppelin)
- EIP-712 signatures for `setAgentWallet`
- Reserved typed fields: `agentWallet`, `oracleAddress`, `participantId`, `cardHash` — protected from generic metadata writes; `agentWallet` and `oracleAddress` cleared on transfer
- One-shot registration: `register(agentURI, metadata[], oracleAddress)`

### `ParticipantRegistry`

- Institution identity registry with permissioned minting
- Records `participantId` on agent NFTs at mint time via `IdentityRegistry._checkAndRecordParticipant`
- Enables bilateral flow authorization: `FlowAuthorizationRegistry` enforces that the flow initiator's `participantId` matches each authorized agent's `participantId`
- `ActionPermitRegistry.setParticipantRegistry()` enables institution-credentialed Tier 2 approvers

### `OnboardingRegistry`

- Central phase bitmask (6 bits) per `traceId`: `PHASE_AML_CLEARED`, `PHASE_CREDIT_ASSESSED`, `PHASE_LEGAL_EXECUTED`, `PHASE_LEGAL_ENTITY_SET_UP`, `PHASE_ACCOUNT_SET_UP`, `PHASE_PRODUCTS_SET_UP`
- Oracle-gated: only the registered bank oracle may advance each phase bit
- `terminateFlow(traceId)` marks a flow inactive; all oracles check `isActive()` before accepting requests

### `AMLOracle`

- Request/response lifecycle for AML screening (`requestReview` → `fulfillReview`)
- Status transitions: Pending → DataRequested ↔ Pending → InHumanReview → [Escalated] → Cleared | Rejected
- Human approver enforcement: clear/reject require `msg.sender != agentWallet` (human must sign, not the oracle bot)
- Advances `PHASE_AML_CLEARED` bit in `OnboardingRegistry` on clearance

### `CreditRiskOracle`

- Assessment + negotiation loop: `requestAssessment` → `fulfillAssessment` → `proposeTerms` → `submitCounterProposal` → `acceptTerms`
- Payload privacy: only `keccak256(payload)` stored on-chain; raw data stays off-chain
- Advances `PHASE_CREDIT_ASSESSED` bit on acceptance

### `LegalOracle`

- Draft / markup negotiation rounds: `requestDraft` → `submitDraft` → `submitMarkup` → `approveBankSide` + `approveClientSide` → `execute`
- Bilateral execution: both `bankApproved` AND `clientApproved` flags must be true before `execute()` succeeds
- Advances `PHASE_LEGAL_EXECUTED` bit on execution

### `ClientSetupOracle`

- Sequential three-step setup: `setupLegalEntity` → `setupAccount` → `setupProducts`
- Each step gated on the preceding phase bit: e.g. `setupAccount` requires `PHASE_LEGAL_ENTITY_SET_UP`
- Advances the corresponding phase bit on completion of each step

### `ExecutionTraceLog`

- Central audit trail — records ordered hops across all oracle contracts
- Each hop captures: calling oracle address, agentId, action name, timestamp
- Queryable via `getTrace(traceId)` — returns the full ordered execution chain
- Owner-configurable: `setMaxHopsPerTrace(n)` and `setLoopDetectionEnabled(bool)`
- Set to `address(0)` to disable tracing with no gas overhead

### `FlowAuthorizationRegistry`

- Per-flow least-privilege authorization: `createFlow(traceId, AgentAuthorization[])` then `isAuthorized(traceId, agentId, capability)`
- **Opt-in**: returns `true` when no policy exists for a `traceId`
- **Immutable**: policies cannot be modified after creation — permanent audit records
- **Bilateral consent** (when `ParticipantRegistry` is configured): `authorizeAgentForFlow` enforces that the flow initiator and agent share the same `participantId`
- Capabilities as `keccak256` hashes: `keccak256("review_code")`, `keccak256("approve_pr")`, etc.

### `ReputationGate`

- Per-capability thresholds: `setThreshold(capability, minScore, scoreDecimals, minCount, tag)`
- Trusted evaluator list: only feedback from registered evaluators counts
- Tag-filtered scoring: passes the threshold's `tag` to `ReputationRegistry.getSummaryFiltered()` to count only capability-relevant feedback
- Anti-gaming: `getSummaryFiltered(agentId, trustedParticipantIds[], participantRegistry, tag1, tag2)` filters by trusted institution

### `PromptRegistry`

- Prompt template governance: `keccak256(template)` stored per capability + version
- Versioned with rollback: `setActiveVersion(capability, index)` activates one version; previous versions are immediately rejected
- **Opt-in**: `isActive()` returns `true` when no active version is configured

### `DatasetRegistry`

- Dataset hash governance: analogous to `PromptRegistry` for training/inference datasets
- Hash-only on-chain; actual datasets referenced by URI

### `AutonomyBoundsRegistry`

- Dynamic tool control: `disableTool(agentId, toolHash)` / `enableTool(agentId, toolHash)` by an authorized monitor
- `isToolEnabled(agentId, toolHash)` called by oracle contracts before accepting fulfillments
- `toolHash = keccak256(bytes(toolName))`
- `bounds-monitor.js` watches for anomaly signals and calls `disableTool` automatically

### `ActionPermitRegistry`

- Action-level authorization with four tiers:
  - `0` — Read (no approval needed)
  - `1` — Reversible write (single-sig)
  - `2` — Destructive / multi-party (multi-sig required)
  - `3` — Forbidden (always blocked)
- `validateAction(flowId, agentId, actionType) view returns (bool)` — hot path, ≤3 SLOADs
- `actionType = keccak256(bytes(patternId))` — e.g. `keccak256("PR:APPROVE")`, `keccak256("SQL:DROP")`
- Oracles emit `ActionBlocked` before reverting — visible in `ExecutionTraceLog`
- `action-gateway.js` provides the `ActionGateway` class for off-chain pre-flight

### `ConsortiumGovernance`

- Member management with M-of-N proposal voting
- Proposal types: `ADD_MEMBER`, `REMOVE_MEMBER`, `PARAM_CHANGE`, `CONTRACT_UPGRADE`, `UNPAUSE`
- `pauseCrossBank(reason)` — any single member; `UNPAUSE` — requires M-of-N quorum
- Governs: `quorumNumerator`, `quorumDenominator`, `votingPeriod`, `upgradeTimelock`

### `ReputationRegistryUpgradeable`

- Records reputation scores linked to agent NFT IDs
- References `IdentityRegistryUpgradeable` for ownership checks
- `getSummaryFiltered(agentId, trustedParticipantIds[], participantRegistry, tag1, tag2)` for anti-gaming queries

---

## Audit exporter

`agents_implementation/audit-exporter.js` indexes on-chain events and exposes them via a REST API:

```bash
node agents_implementation/audit-exporter.js \
  --rpc http://127.0.0.1:8545 \
  --identity 0x<IdentityRegistry> \
  --trace-log 0x<ExecutionTraceLog> \
  --participant-registry 0x<ParticipantRegistry> \
  --autonomy-bounds 0x<AutonomyBoundsRegistry> \
  --action-permit 0x<ActionPermitRegistry> \
  --port 3000
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `hardhat` | EVM development environment |
| `@openzeppelin/contracts` | ERC-721, ECDSA, EIP-712 |
| `@openzeppelin/contracts-upgradeable` | UUPS proxy pattern |
| `@openzeppelin/hardhat-upgrades` | Proxy-aware deploy helpers |
| `@nomicfoundation/hardhat-ethers` | ethers.js v6 integration |
| `ethers` | Ethereum JS library |

```bash
npm install
```

---

## Design documents

| Document | Contents |
|---|---|
| [`design/concepts.md`](./design/concepts.md) | Index of all R&D concepts — start here |
| [`design/architecture.proposal.md`](./design/architecture.proposal.md) | Full ERC-8004 + MCP design rationale |
| [`design/8004.refactor.md`](./design/8004.refactor.md) | Identity registry refactor notes |
| [`design/mcp.extension.md`](./design/mcp.extension.md) | MCP extensions — autonomy bounds, action permits, card hash |
| [`design/b2b.agentic.flow.md`](./design/b2b.agentic.flow.md) | B2B agentic controls (P0–P4) |
| [`design/onboarding.flow.md`](./design/onboarding.flow.md) | Onboarding flow walkthrough |
| [`paper/paper.md`](./paper/paper.md) | Research paper with complete architecture description |

---

## Simulation run

A full end-to-end demo of the B2B onboarding flow — all 15 contracts deployed, all 10 agents registered, and the complete AML → Credit → Legal → Setup lifecycle driven on-chain.

### Single-session verification (no persistent node required)

```bash
npx hardhat run scripts/verify-simulation.js
```

Deploys and drives the full flow in one Hardhat session. Exit code 0 means `ReadyToTransact` was confirmed.

### Five-terminal workflow

| Terminal | Command |
|---|---|
| 1 | `npx hardhat node` |
| 2 | `node scripts/deploy.js` |
| 3 | `node agents_implementation/launch-agents.js` |
| 4 | *(copy-paste the command printed by terminal 2)* |
| 5 | `npx hardhat run scripts/flow-driver.js --network localhost` |

**Terminal 2** (`deploy.js`) deploys all 15 contracts, wires governance (FlowAuthorizationRegistry bilateral consent gate, ActionPermitRegistry institution-credentialed approvers, ExecutionTraceLog hop policy), registers all 10 agents with oracle bindings and card hashes, and writes `simulation-addresses.json`. At the end it prints a ready-to-paste `launch-bridges.js` command with every address and agent ID filled in.

**Terminal 5** (`flow-driver.js`) reads `simulation-addresses.json` and drives each oracle function in sequence using the correct Hardhat signers:

```
[1] OnboardingRegistry.initiateOnboarding
[2] AML:    requestAMLReview → submitRecommendation → clear (human approver)
[3] Credit: requestCreditReview → submitRecommendation → approve (human approver)
[4] Legal:  requestLegalReview → issueDraft → submitMarkup (HF) →
            submitRecommendation → approveBankSide + approveClientSide → execute
[5] Confirm phaseBitmask == 0x07 (ALL_REVIEWS_DONE)
[6] setupLegalEntity → setupAccount → setupProducts
[7] ReadyToTransact ✓  (phaseBitmask == 0x3F)
```

The flow-driver uses `signers[0]` as the bank Tier-2 human approver, `signers[1..10]` as agent wallets (matching the registration order in deploy.js), and `signers[11]` as the HF institution Tier-2 human approver for bilateral legal approval.

---

## .gitignore recommendations

```
node_modules/
artifacts/
cache/
hardhat-node.log
hardhat-node.err.log
agents_implementation/logs/
agents_implementation/agent-pids.txt
agents_implementation/bounds-state.json
deployed-addresses.json
.env
```
