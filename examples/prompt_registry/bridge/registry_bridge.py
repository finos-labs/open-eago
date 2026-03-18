"""
registry_bridge.py — CI/CD tool: load a prompt from prompts/, push to LangSmith,
and register its keccak256 hash on-chain.

Source of truth: prompts/<prompt-name>.yaml (checked into git, reviewed via PR).
Flow:
  1. Load prompt from prompts/<name>.yaml
  2. Compute keccak256(canonical_content)
  3. Push to LangSmith → get commit hash
  4. Register (promptId, langsmith_commit, contentHash) on-chain

Usage:
    python registry_bridge.py --prompt-name bank-aml-agent

    # Skip LangSmith push (hash-only registration, e.g. for local dev):
    python registry_bridge.py --prompt-name bank-aml-agent --no-langsmith

Environment variables (or .env file):
    LANGCHAIN_API_KEY           LangSmith API key
    PROMPT_REGISTRY_ADDRESS     Deployed PromptRegistry contract address
    RPC_URL                     Ethereum RPC endpoint
    REGISTRY_PRIVATE_KEY        Private key for the contract owner account
"""

import argparse
import os
import sys

from dotenv import load_dotenv
from web3 import Web3
from web3.middleware import SignAndSendRawMiddlewareBuilder

from langsmith_client import (
    load_local_prompt,
    prompt_id_bytes32,
    push_to_langsmith,
)

load_dotenv()

REGISTRY_ABI = [
    {
        "inputs": [
            {"internalType": "bytes32", "name": "promptId",    "type": "bytes32"},
            {"internalType": "string",  "name": "version",     "type": "string"},
            {"internalType": "bytes32", "name": "contentHash", "type": "bytes32"},
        ],
        "name": "register",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
]


def main():
    parser = argparse.ArgumentParser(
        description="Load a prompt from prompts/, push to LangSmith, register hash on-chain."
    )
    parser.add_argument("--prompt-name", required=True, help="Prompt name (matches prompts/<name>.yaml)")
    parser.add_argument("--no-langsmith", action="store_true", help="Skip LangSmith push; use local version string")
    args = parser.parse_args()

    rpc_url          = os.environ["RPC_URL"]
    private_key      = os.environ["REGISTRY_PRIVATE_KEY"]
    registry_address = os.environ["PROMPT_REGISTRY_ADDRESS"]

    # 1. Load from local file
    print(f"Loading prompts/{args.prompt_name}.yaml...")
    spec, canonical, content_hash = load_local_prompt(args.prompt_name)
    prompt_id = prompt_id_bytes32(args.prompt_name)

    print(f"  promptId    : 0x{prompt_id.hex()}")
    print(f"  contentHash : 0x{content_hash.hex()}")
    print(f"  canonical   : {canonical[:120]}{'...' if len(canonical) > 120 else ''}")

    # 2. Push to LangSmith (unless skipped)
    if args.no_langsmith:
        version = spec.get("version", "local")
        print(f"  Skipping LangSmith push. Using version: {version}")
    else:
        print(f"Pushing to LangSmith as '{args.prompt_name}'...")
        version = push_to_langsmith(spec)
        print(f"  LangSmith commit: {version}")

    # 3. Register on-chain
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    account = w3.eth.account.from_key(private_key)
    w3.middleware_onion.inject(SignAndSendRawMiddlewareBuilder.build(account), layer=0)
    w3.eth.default_account = account.address

    registry = w3.eth.contract(
        address=Web3.to_checksum_address(registry_address),
        abi=REGISTRY_ABI,
    )

    print(f"Registering on-chain (version={version})...")
    tx_hash = registry.functions.register(
        prompt_id,
        version,
        content_hash,
    ).transact()

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if receipt.status != 1:
        print("ERROR: transaction reverted", file=sys.stderr)
        sys.exit(1)

    print(f"Registered. tx: 0x{tx_hash.hex()}")
    print(f"\nSet in your bridge environment:")
    print(f"  {args.prompt_name.upper().replace('-', '_')}_PROMPT_VERSION={version}")


if __name__ == "__main__":
    main()
