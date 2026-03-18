"""
runtime_verifier.py — runtime guard: fetch a prompt from LangSmith, recompute its hash,
and verify it matches the value registered on-chain. Raises PromptTamperError on mismatch.

Intended to be called at agent startup or before each inference invocation.

Usage (standalone):
    python runtime_verifier.py --prompt-name aml-review-agent --version abc123

As a library:
    from runtime_verifier import verify_or_raise
    prompt_template = verify_or_raise("aml-review-agent", "abc123")

Environment variables (or .env file):
    LANGCHAIN_API_KEY           LangSmith API key
    PROMPT_REGISTRY_ADDRESS     Deployed PromptRegistry contract address
    RPC_URL                     Ethereum RPC endpoint
"""

import argparse
import os
import sys

from dotenv import load_dotenv
from web3 import Web3

from langsmith_client import fetch_and_hash, prompt_id_bytes32

load_dotenv()

REGISTRY_ABI = [
    {
        "inputs": [
            {"internalType": "bytes32", "name": "promptId",    "type": "bytes32"},
            {"internalType": "string",  "name": "version",     "type": "string"},
            {"internalType": "bytes32", "name": "contentHash", "type": "bytes32"},
        ],
        "name": "verify",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "bytes32", "name": "promptId", "type": "bytes32"},
            {"internalType": "string",  "name": "version",  "type": "string"},
        ],
        "name": "getHash",
        "outputs": [{"internalType": "bytes32", "name": "", "type": "bytes32"}],
        "stateMutability": "view",
        "type": "function",
    },
]


class PromptTamperError(RuntimeError):
    """Raised when the fetched prompt does not match the on-chain registered hash."""


def _registry(w3: Web3) -> object:
    address = os.environ["PROMPT_REGISTRY_ADDRESS"]
    return w3.eth.contract(
        address=Web3.to_checksum_address(address),
        abi=REGISTRY_ABI,
    )


def verify_or_raise(prompt_name: str, version: str):
    """
    Fetch the prompt from LangSmith, recompute keccak256, and verify against the chain.

    Returns the LangChain prompt template on success.
    Raises PromptTamperError if:
      - the prompt/version pair is not registered on-chain, or
      - the recomputed hash does not match the registered hash.
    """
    from langsmith import Client
    from langsmith_client import _serialize_prompt

    rpc_url = os.environ["RPC_URL"]
    w3 = Web3(Web3.HTTPProvider(rpc_url))
    registry = _registry(w3)

    # Fetch
    client = Client()
    prompt_template = client.pull_prompt(f"{prompt_name}:{version}")
    canonical = _serialize_provider(prompt_template)
    content_hash: bytes = Web3.keccak(text=canonical)
    prompt_id = prompt_id_bytes32(prompt_name)

    # Verify on-chain
    ok: bool = registry.functions.verify(prompt_id, version, content_hash).call()
    if not ok:
        on_chain = registry.functions.getHash(prompt_id, version).call()
        if on_chain == b"\x00" * 32:
            raise PromptTamperError(
                f"Prompt '{prompt_name}:{version}' is not registered on-chain. "
                "Run registry_bridge.py in CI/CD to register it first."
            )
        raise PromptTamperError(
            f"Hash mismatch for '{prompt_name}:{version}'. "
            f"On-chain: 0x{on_chain.hex()} | Computed: 0x{content_hash.hex()}. "
            "Prompt may have been modified after registration."
        )

    return prompt_template


# Re-export the serialization helper (avoids a circular import in the verify path)
def _serialize_provider(prompt_template) -> str:
    from langsmith_client import _serialize_prompt
    return _serialize_prompt(prompt_template)


def main():
    parser = argparse.ArgumentParser(description="Verify a LangSmith prompt against its on-chain hash.")
    parser.add_argument("--prompt-name", required=True)
    parser.add_argument("--version",     required=True)
    args = parser.parse_args()

    try:
        verify_or_raise(args.prompt_name, args.version)
        print(f"OK — '{args.prompt_name}:{args.version}' matches on-chain hash.")
    except PromptTamperError as e:
        print(f"TAMPER DETECTED: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
