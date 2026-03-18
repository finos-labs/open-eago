# Prompt Registry

Closes the **prompt governance gap** identified in the `mcp-erc8004-enterprise` research paper by binding LangSmith prompt versions to on-chain keccak256 hashes. This is a standalone implementation of **Layer 4 (Prompt Governance)** from the nine-layer authorization stack.

## Design connection: mcp-erc8004-enterprise

### The problem this solves

The [paper](../mcp-erc8004-enterprise/paper/paper.md) (§8 — "The LLM Inference Gap") identifies a fundamental blind spot: on-chain governance can verify *that* an agent ran, but cannot see *what prompt* was used to drive the LLM. An attacker who modifies a prompt template after it has been reviewed and approved can subvert agent behavior without triggering any on-chain alarm.

[Layer 4 of the nine-layer stack](../mcp-erc8004-enterprise/CLAUDE.md) (`PromptRegistry`) is designed to close this gap. This example provides the full implementation of that layer.

### Where Layer 4 sits in the stack

| Layer | Contract | Check |
|---|---|---|
| 1 | `IdentityRegistryUpgradeable` | Wallet + oracle binding |
| 2 | `FlowAuthorizationRegistry` | Agent authorized for this flow |
| 3 | `ReputationGate` | Agent meets reputation threshold |
| **4** | **`PromptRegistry`** | **Agent using approved prompt template** ← this example |
| 5 | `DatasetRegistry` | Agent using approved dataset |
| 6 | `AutonomyBoundsRegistry` | Tool not suspended |
| 7 | `ExecutionTraceLog` | Loop / hop policy not violated |
| 8 | `IdentityRegistryUpgradeable` | Agent card hash matches on-chain |
| 9 | `ActionPermitRegistry` | Action tier permitted |

### Design documents

- [architecture.proposal.md](../mcp-erc8004-enterprise/design/architecture.proposal.md) — full ERC-8004 + MCP design; introduces the nine governance layers
- [concepts/prompt-governance.md](../mcp-erc8004-enterprise/design/concepts/prompt-governance.md) — deep dive on Layer 4 rationale
- [paper/paper.md §8](../mcp-erc8004-enterprise/paper/paper.md) — the inference gap and why on-chain hashing is the mitigation

## Code connection: mcp-erc8004-enterprise

This example's bridge code has been directly integrated into the `mcp-erc8004-enterprise` agent implementation:

| This example | mcp-erc8004-enterprise counterpart | Role |
|---|---|---|
| `bridge/langsmith_client.py` | `shared/prompt_verifier.py` | LangSmith fetch + keccak256 |
| `bridge/runtime_verifier.py` | `shared/prompt_verifier.py` | `verify_prompt_at_startup()` + `PromptTamperError` |
| `contracts/PromptRegistry.sol` | `shared/abis.py` → `PROMPT_REGISTRY_ABI` | ABI fragment used by the verifier |
| _(standalone)_ | `shared/bridge_base.py` → `bootstrap_bridge()` | Runs prompt check at startup for every bridge |
| _(standalone)_ | `bridges/aml_bridge.py` | Reference wiring: `prompt_name="bank-aml-agent"` |

The integration point in `bridge_base.py`:

```python
# Layer 4 — prompt hash check at bridge startup
ctx = await bootstrap_bridge(
    "aml-bridge",
    contract_flag="--contract",
    contract_env="AML_CONTRACT_ADDRESS",
    agent_id_env="AML_AGENT_ID",
    card_glob="bank-aml-agent.json",
    prompt_name="bank-aml-agent",       # ← Layer 4: LangSmith prompt name
    prompt_version_env="AML_PROMPT_VERSION",
)
```

When `PROMPT_REGISTRY_ADDRESS` and `AML_PROMPT_VERSION` are set, `bootstrap_bridge()` will:
1. Pull the prompt from LangSmith
2. Recompute `keccak256(canonical_content)`
3. Call `PromptRegistry.verify()` on-chain
4. Exit with an error if there is a hash mismatch (`PromptTamperError`)

## How it works

Prompt text lives in this repo (`prompts/`) as the single source of truth, reviewed via git PRs. From there it flows to LangSmith for versioned runtime delivery, and a hash of the content is anchored on-chain for tamper detection.

```
prompts/<agent>.yaml          git — PR-reviewed source of truth
        │
        ├── seed_langsmith.py      → LangSmith (versioned delivery, returns commit hash)
        │
        └── registry_bridge.py    → push to LangSmith + register hash on-chain
                                            ↓
                                      PromptRegistry.sol
                                            ↓
                          runtime_verifier / bridge_base verify at agent startup
```

### Three-way consistency

| Store | What lives there | Role |
|---|---|---|
| `prompts/*.yaml` | Canonical prompt text | Audit trail, PR review, diff history |
| LangSmith | Versioned prompt snapshots | Runtime delivery, commit-pinned references |
| `PromptRegistry.sol` | `keccak256(canonical_content)` | Tamper detection at agent startup |

The on-chain hash is computed from the local YAML, not from LangSmith, so git is the root of trust.

## Structure

```
prompts/
  bank-aml-agent.yaml           canonical prompt text (source of truth)
  bank-credit-risk-agent.yaml
  bank-legal-agent.yaml
contracts/
  PromptRegistry.sol            on-chain hash store
scripts/
  deploy.js                     Hardhat deploy + example registration
test/
  PromptRegistry.test.js        11 Hardhat/Chai unit tests
bridge/
  langsmith_client.py           load from prompts/, push to LangSmith, fetch + hash
  registry_bridge.py            CI/CD: load → push to LangSmith → register hash on-chain
  seed_langsmith.py             push all local prompts to LangSmith (initial setup / testing)
  runtime_verifier.py           standalone runtime verifier (verify_or_raise)
  pyproject.toml
  .env.example
```

## Quickstart

### 1. Contracts

```bash
npm install
npm test                         # 11 passing
npx hardhat node                 # start local node (separate terminal)
npm run deploy                   # deploy PromptRegistry, prints address
```

### 2. Seed LangSmith

```bash
cd bridge
pip install -e .
cp .env.example .env             # fill in LANGCHAIN_API_KEY, RPC_URL, REGISTRY_PRIVATE_KEY, PROMPT_REGISTRY_ADDRESS

# Push all prompts from prompts/ to LangSmith and print commit hashes
python seed_langsmith.py

# Or push a single prompt
python seed_langsmith.py --prompt-name bank-aml-agent
```

### 3. Register hashes on-chain (CI/CD)

```bash
# Load from prompts/, push to LangSmith, register hash on-chain in one step
python registry_bridge.py --prompt-name bank-aml-agent

# Skip LangSmith push (local dev, no API key needed)
python registry_bridge.py --prompt-name bank-aml-agent --no-langsmith
```

### 4. Verify at runtime (standalone)

```bash
python runtime_verifier.py --prompt-name bank-aml-agent --version <langsmith-commit>
```

### 5. Wire into mcp-erc8004-enterprise bridges

```bash
# In mcp-erc8004-enterprise/agents_implementation_py/
export PROMPT_REGISTRY_ADDRESS=0x...
export AML_PROMPT_VERSION=<langsmith-commit>   # printed by seed_langsmith.py / registry_bridge.py

python launch_bridges.py --rpc http://127.0.0.1:8545 --privkey 0x... \
  --aml-contract 0x... \
  --prompt-registry $PROMPT_REGISTRY_ADDRESS
```

## Security notes

- The `prompts/*.yaml` files are the root of trust — changes must go through a PR and be reviewed before `registry_bridge.py` is run.
- Pin to a **LangSmith commit hash**, not a mutable tag — tags can be reassigned, commit hashes cannot.
- The `REGISTRY_PRIVATE_KEY` account is the contract owner — restrict it to CI/CD only; never use it at runtime.
- A missing on-chain registration logs a warning but does not abort (dev-friendly). A hash mismatch exits immediately (`PromptTamperError`) — this is the tamper signal.
