# Prompt Registry

Closes the "LLM inference gap" described in the [mcp-8004-enterprise paper](../mcp-8004-enterprise/paper/paper.md) (§8, Layer 4) by binding LangSmith prompt versions to on-chain keccak256 hashes.

## How it works

```
CI/CD pipeline
  └── registry_bridge.py
        ├── pull prompt from LangSmith (name:commit)
        ├── compute keccak256(canonical_content)
        └── register(promptId, version, hash) → PromptRegistry.sol

Agent startup / pre-inference
  └── runtime_verifier.py
        ├── pull same prompt from LangSmith
        ├── recompute keccak256
        └── verify(promptId, version, hash) → abort on mismatch
```

## Structure

```
contracts/          PromptRegistry.sol — on-chain hash store
scripts/            deploy.js          — Hardhat deploy script
test/               PromptRegistry.test.js
bridge/
  langsmith_client.py   fetch + hash
  registry_bridge.py    CI/CD: register hash on-chain
  runtime_verifier.py   runtime: verify hash or raise
  pyproject.toml
  .env.example
```

## Quickstart

### 1. Contracts

```bash
npm install
npm test                         # run Hardhat tests
npx hardhat node                 # start local node (separate terminal)
npm run deploy                   # deploy PromptRegistry, prints address
```

### 2. Bridge

```bash
cd bridge
pip install -e .
cp .env.example .env             # fill in keys + deployed address

# CI/CD: register a prompt hash
python registry_bridge.py --prompt-name aml-review-agent --version abc123

# Runtime: verify before inference
python runtime_verifier.py --prompt-name aml-review-agent --version abc123
```

## Security notes

- Pin `--version` to a **commit hash**, not a mutable tag, for maximum tamper resistance.
- The `REGISTRY_PRIVATE_KEY` account is the contract owner — restrict it to CI/CD only.
- `runtime_verifier.verify_or_raise()` should be called at agent startup; abort the workflow if it raises `PromptTamperError`.
