# CLAUDE.md

> **Maintenance rule:** update this file when making significant structural changes.

## What this example is

`prompt_registry` demonstrates how to close the **prompt governance gap** (Layer 4 of the nine-layer stack in `mcp-erc8004-enterprise`) by:

1. Storing approved prompt template hashes on-chain in `PromptRegistry.sol`.
2. Fetching prompts from **LangSmith** at CI/CD time, computing `keccak256` of their canonical content, and registering the hash on-chain (`registry_bridge.py`).
3. Re-verifying at **runtime** before each agent invocation — aborting if the hash doesn't match (`runtime_verifier.py`).

## Commands

### Contracts

```bash
npm install
npm test                    # Hardhat in-process tests (no node needed)
npx hardhat node            # local node (separate terminal)
npm run deploy              # deploy + register placeholder hash
```

### Bridge (Python)

```bash
cd bridge && pip install -e .
cp .env.example .env        # fill in LANGCHAIN_API_KEY, RPC_URL, REGISTRY_PRIVATE_KEY, PROMPT_REGISTRY_ADDRESS

python registry_bridge.py  --prompt-name <name> --version <langsmith-commit>
python runtime_verifier.py --prompt-name <name> --version <langsmith-commit>
```

## Architecture

```
LangSmith (prompt hub)
    │  pull_prompt(name:commit)
    ▼
langsmith_client.py
    │  canonical JSON → keccak256
    ├──► registry_bridge.py  → register() → PromptRegistry.sol  [CI/CD]
    └──► runtime_verifier.py → verify()   → PromptRegistry.sol  [Runtime]
```

## Key conventions

- `promptId` = `keccak256(text=prompt_name)` — computed by `prompt_id_bytes32()`.
- `version` = LangSmith commit hash (preferred) or semver tag string.
- `contentHash` = `keccak256(canonical_json)` where canonical JSON is deterministic (sorted keys, no extra whitespace).
- Always pin to a **commit hash**, not a mutable tag, in production.
- `PromptTamperError` raised by `verify_or_raise()` should cause the calling agent to abort its workflow entirely.

## Files

| File | Purpose |
|---|---|
| `contracts/PromptRegistry.sol` | On-chain store: `register`, `getHash`, `verify` |
| `scripts/deploy.js` | Deploy contract + register example placeholder |
| `test/PromptRegistry.test.js` | 10 Hardhat/Chai unit tests |
| `bridge/langsmith_client.py` | LangSmith fetch + keccak256 hash |
| `bridge/registry_bridge.py` | CI/CD: register hash on-chain |
| `bridge/runtime_verifier.py` | Runtime: verify or raise `PromptTamperError` |
