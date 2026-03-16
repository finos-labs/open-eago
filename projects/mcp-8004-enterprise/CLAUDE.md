# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Maintenance rule:** when updating design documents or making significant code changes, update this file before finishing.

## What this project is

`botman_8004` is a local development environment for an **enterprise agentic workflow framework** built on two complementary standards:

- **ERC-8004** — on-chain agent identity registry: each agent is an ERC-721 NFT with a verified wallet, a bound oracle contract, and arbitrary capability metadata.
- **MCP (Model Context Protocol)** — agent invocation standard: each agent exposes tools/resources/prompts over HTTP/JSON-RPC 2.0.

The binding: every agent card points to an MCP spec, every MCP spec drives a Solidity oracle contract, and the identity registry binds agent identity to that oracle in a single `register()` transaction.

The primary use case is a **cross-institutional B2B onboarding flow** between a bank and a hedge fund client, orchestrated entirely by on-chain oracle contracts and off-chain MCP servers.

## Commands

### Contracts (root)

```bash
npm run compile           # or: npx hardhat compile
npm test                  # or: npx hardhat test  (17 test files, no running node needed)
npx hardhat node          # start local Hardhat node (keep in a separate terminal)
```

> Hardhat config: Solidity 0.8.22, optimizer runs: 1, `viaIR: true` (required for deep stack in oracle fulfillment functions). Networks: `hardhat` (in-process) and `localhost` (127.0.0.1:8545).

### Off-chain servers (agents_implementation_py/)

```bash
# Install
cd agents_implementation_py && pip install -e .

# MCP servers (ports 8010–8022)
python agents_implementation_py/launch_servers.py

# Oracle bridges
python agents_implementation_py/launch_bridges.py \
  --rpc                  http://127.0.0.1:8545 \
  --privkey              0x<OraclePrivateKey> \
  --onboarding-registry  0x... \
  --aml-contract         0x... \
  --credit-contract      0x... \
  --legal-contract       0x... \
  --setup-contract       0x...
```

Optional bridge flags (also readable from env):

| Flag | Env var | Purpose |
|---|---|---|
| `--identity-registry` | `IDENTITY_REGISTRY_ADDRESS` | Card hash startup check |
| `--flow-auth` | `FLOW_AUTH_ADDRESS` | Flow authorization gate |
| `--reputation-gate` | `REPUTATION_GATE_ADDRESS` | Reputation threshold gate |
| `--autonomy-bounds` | `AUTONOMY_BOUNDS_ADDRESS` | Tool enable/disable governance |
| `--action-permit` | `ACTION_PERMIT_ADDRESS` | Action-level pre-flight |

Set `OPENAI_API_KEY` for LLM inference. `VaultSigner` (`shared/vault_signer.py`) supports a local private key or HashiCorp Vault (HSM): set `VAULT_ADDR` + `VAULT_TOKEN` + `VAULT_KEY_NAME`.

> **Bounds monitor:** `bounds-monitor.js` (archived with the Node.js runtime — see git tag `node-js-runtime-archive`) has no Python replacement yet. Python servers degrade gracefully: if `bounds-state.json` is absent, all tools are assumed enabled. Set `BOUNDS_STATE_PATH` to an empty JSON file to suppress the log warning.

## Architecture

```
Agent Card (agents/*.json)
  └── mcpSpec → agents/mcp/*.mcp.json
        ├── Solidity Oracle (contracts/oracles/)              on-chain request/response lifecycle
        ├── MCP Server (agents_implementation_py/servers/)    off-chain tool implementation
        └── Oracle Bridge (agents_implementation_py/bridges/) event watcher + fulfillment tx submitter
```

Three-tier topology:

```
BANK ──TX──► AMLOracle / CreditRiskOracle / LegalOracle / ClientSetupOracle ◄──TX── HF CLIENT
       ◄─EVENT──────────────── OnboardingRegistry ───────────────────EVENT──►
                                 ExecutionTraceLog
```

### On-chain ↔ off-chain flow

1. A caller submits an on-chain request to an oracle contract (e.g. `AMLOracle.requestReview`), emitting an event with a `bytes32 traceId`.
2. The corresponding bridge watches for that event, calls the MCP server tool via `POST /mcp`, and submits a fulfillment transaction back to the oracle.
3. The oracle's `onlyRegisteredOracle(agentId)` modifier verifies `msg.sender == agentWallet` AND `oracleAddress == address(this)` via `IIdentityRegistry` — registration is the sole authorization mechanism, no whitelist needed.

### Nine-layer authorization stack

Every oracle fulfillment passes through up to nine opt-in layers (each returns `true` when not configured):

| Layer | Contract | Check |
|---|---|---|
| 1 | `IdentityRegistryUpgradeable` | Wallet + oracle binding (`onlyRegisteredOracle`) |
| 2 | `FlowAuthorizationRegistry` | Agent authorized for this specific `traceId` |
| 3 | `ReputationGate` | Agent meets min-score + min-count threshold |
| 4 | `PromptRegistry` | Agent using current approved prompt template |
| 5 | `DatasetRegistry` | Agent using an approved dataset |
| 6 | `AutonomyBoundsRegistry` | Tool currently enabled (not suspended by monitor) |
| 7 | `ExecutionTraceLog` | Hop count / loop policy not violated |
| 8 | `IdentityRegistryUpgradeable` (`cardHash`) | Live agent card matches on-chain registered hash |
| 9 | `ActionPermitRegistry` | Action tier permitted for this flow + agent |

### Contract directory layout

```
contracts/
├── oracles/
│   ├── AMLOracle.sol              # AML screening: requestReview → fulfillReview
│   ├── CreditRiskOracle.sol       # Credit assessment + term negotiation
│   ├── LegalOracle.sol            # Draft/markup bilateral approval lifecycle
│   ├── ClientSetupOracle.sol      # Sequential: setupLegalEntity → setupAccount → setupProducts
│   └── MockOracle.sol             # Minimal stub for unit tests
└── registries/
    ├── IdentityRegistryUpgradeable.sol   # ERC-8004: ERC-721 identity + oracle binding (UUPS)
    ├── ParticipantRegistry.sol           # Institution identity; permissioned minting
    ├── OnboardingRegistry.sol            # Phase bitmask (6 bits) + termination per flow
    ├── FlowAuthorizationRegistry.sol     # Per-flow least-privilege agent authorization
    ├── ReputationRegistryUpgradeable.sol # Reputation scores keyed by agent NFT ID (UUPS)
    ├── ReputationGate.sol                # Min-score + min-count quality gate
    ├── PromptRegistry.sol                # Prompt template governance (keccak256 hashes)
    ├── DatasetRegistry.sol               # Dataset hash governance
    ├── AutonomyBoundsRegistry.sol        # Dynamic tool enable/disable by monitor
    ├── ActionPermitRegistry.sol          # Action-level authorization (four tiers)
    ├── ExecutionTraceLog.sol             # Distributed tracing: ordered hops per traceId
    ├── ConsortiumGovernance.sol          # M-of-N member proposals + emergency pause
    ├── MockMultiSig.sol                  # M-of-N threshold multi-sig for testing
    └── I*.sol                            # Interfaces consumed by oracle contracts
```

### Off-chain components

| File | Role |
|---|---|
| `shared/server_base.py` | FastMCP server factory + `@suspended_when_revoked` decorator |
| `shared/bridge_base.py` | Bridge bootstrap: web3.py provider/signer, governance preflight, `call_mcp_tool` |
| `shared/vault_signer.py` | `LocalSigner` / `VaultSigner` — local key or HashiCorp Vault backend |
| `shared/bounds_monitor_client.py` | Reads `bounds-state.json`, POSTs to `:9090/report` (graceful degradation if absent) |
| `graph/onboarding_graph.py` | LangGraph `StateGraph` for the onboarding orchestrator bridge |
| `launch_servers.py` | Spawns one server process per `agents/*.json` card |
| `launch_bridges.py` | Spawns all 8 bridge processes with shared CLI flags |

### Agent cards and capability → server mapping

10 agent cards in `agents/`, ports 8010–8022:

| Capability | Server | Agent(s) |
|---|---|---|
| `aml-review` | `aml_server.py` | `bank-aml-agent` (8010) |
| `credit-risk` | `credit_risk_server.py` | `bank-credit-risk-agent` (8011) |
| `legal-review` | `legal_server.py` | `bank-legal-agent` (8012) |
| `onboarding` | `onboarding_orchestrator_server.py` | `bank-onboarding-orchestrator` (8013) |
| `client-setup` | `client_setup_server.py` | `bank-legal-entity-setup-agent` (8014), `bank-account-setup-agent` (8015), `bank-product-setup-agent` (8016) |
| `hf-document` | `hf_document_server.py` | `hf-document-agent` (8020) |
| `hf-credit-negotiator` | `hf_credit_negotiator_server.py` | `hf-credit-negotiator-agent` (8021) |
| `hf-legal` | `hf_legal_server.py` | `hf-legal-agent` (8022) |

### Distributed tracing

Every on-chain request carries a `bytes32 traceId`. `ExecutionTraceLog` records ordered hops: `(traceId, callingOracle, agentId, actionName, timestamp)`. Query with `getTrace(traceId)`. Owner-configurable: `setMaxHopsPerTrace(n)` and `setLoopDetectionEnabled(bool)`.

### Key conventions

- `toolHash` = `keccak256(bytes(toolName))` — used by `AutonomyBoundsRegistry`
- `capabilityHash` = `keccak256(bytes(capabilityTag))` — used by `ReputationGate` / `FlowAuthorizationRegistry`
- `actionType` = `keccak256(bytes(patternId))` — used by `ActionPermitRegistry` (e.g. `keccak256("PR:APPROVE")`)
- Payload privacy: only `keccak256(payload)` stored on-chain; raw data stays off-chain
- `participantId` is a reserved key in `IdentityRegistryUpgradeable` — set at mint via `_checkAndRecordParticipant`, cannot be set via generic `setMetadata`

## Design documents

- [`design/concepts.md`](./design/concepts.md) — index of all R&D concepts; start here
- [`design/architecture.proposal.md`](./design/architecture.proposal.md) — full ERC-8004 + MCP design rationale
- [`design/8004.refactor.md`](./design/8004.refactor.md) — identity registry refactor notes
- [`design/mcp.extension.md`](./design/mcp.extension.md) — MCP extensions (autonomy bounds, action permits, card hash)
- [`design/b2b.agentic.flow.md`](./design/b2b.agentic.flow.md) — B2B agentic controls (P0–P4)
- [`design/onboarding.flow.md`](./design/onboarding.flow.md) — onboarding flow walkthrough
- [`paper/paper.md`](./paper/paper.md) — research paper with complete architecture description
