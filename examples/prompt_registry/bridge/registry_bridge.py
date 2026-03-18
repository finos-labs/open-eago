"""
registry_bridge.py — CI/CD tool: fetch a prompt from LangSmith and register its hash on-chain.

Intended to run in a CI/CD pipeline whenever a new prompt version is approved.

Usage:
    python registry_bridge.py --prompt-name aml-review-agent --version abc123

Environment variables (or .env file):
    LANGCHAIN_API_KEY           LangSmith API key
    PROMPT_REGISTRY_ADDRESS     Deployed PromptRegistry contract address
    RPC_URL                     Ethereum RPC endpoint (e.g. http://127.0.0.1:8545)
    REGISTRY_PRIVATE_KEY        Private key for the owner account
"""

import argparse
import os
import sys

from dotenv import load_dotenv
from web3 import Web3
from web3.middleware import SignAndSendRawMiddlewareBuilder

from langsmith_client import fetch_and_hash, prompt_id_bytes32

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
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True,  "internalType": "bytes32", "name": "promptId",    "type": "bytes32"},
            {"indexed": False, "internalType": "string",  "name": "version",     "type": "string"},
            {"indexed": False, "internalType": "bytes32", "name": "contentHash", "type": "bytes32"},
            {"indexed": False, "internalType": "address", "name": "registeredBy","type": "address"},
        ],
        "name": "PromptRegistered",
        "type": "event",
    },
]


def main():
    parser = argparse.ArgumentParser(description="Register a LangSmith prompt hash on-chain.")
    parser.add_argument("--prompt-name", required=True, help="LangSmith prompt name")
    parser.add_argument("--version",     required=True, help="LangSmith commit hash or tag")
    args = parser.parse_args()

    rpc_url          = os.environ["RPC_URL"]
    private_key      = os.environ["REGISTRY_PRIVATE_KEY"]
    registry_address = os.environ["PROMPT_REGISTRY_ADDRESS"]

    # Fetch + hash
    print(f"Fetching {args.prompt_name}:{args.version} from LangSmith...")
    canonical, content_hash = fetch_and_hash(args.prompt_name, args.version)
    prompt_id = prompt_id_bytes32(args.prompt_name)

    print(f"  promptId    : 0x{prompt_id.hex()}")
    print(f"  contentHash : 0x{content_hash.hex()}")
    print(f"  canonical   : {canonical[:120]}{'...' if len(canonical) > 120 else ''}")

    # Connect
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    account = w3.eth.account.from_key(private_key)
    w3.middleware_onion.inject(SignAndSendRawMiddlewareBuilder.build(account), layer=0)
    w3.eth.default_account = account.address

    registry = w3.eth.contract(
        address=Web3.to_checksum_address(registry_address),
        abi=REGISTRY_ABI,
    )

    # Register
    print(f"Registering on-chain via {registry_address}...")
    tx_hash = registry.functions.register(
        prompt_id,
        args.version,
        content_hash,
    ).transact()

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
    if receipt.status != 1:
        print("ERROR: transaction reverted", file=sys.stderr)
        sys.exit(1)

    print(f"Registered. tx: 0x{tx_hash.hex()}")


if __name__ == "__main__":
    main()
