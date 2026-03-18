"""
prompt_hash.py — Canonical keccak256 hash for LangChain prompt templates.

Critical: the serialization rule MUST produce byte-identical output to
JavaScript's JSON.stringify(messages) for the same ASCII-safe input.

Python:  json.dumps(messages, separators=(',', ':'), ensure_ascii=False)
JS:      JSON.stringify(messages)   (default — no spaces)

Both use keccak256(UTF-8 bytes of the canonical JSON string).
"""

import json
from web3 import Web3


def canonical_hash(messages: list[dict]) -> bytes:
    """
    Compute keccak256(canonical_json(messages)) → bytes32.

    Args:
        messages: List of {"role": str, "content": str} dicts
                  (the langchain_messages array from the MCP spec).

    Returns:
        32-byte keccak256 digest (bytes, not hex string).

    Usage:
        from shared.prompt_hash import canonical_hash
        h = canonical_hash(spec["prompts"][0]["langchain_messages"])
        # h is bytes32 compatible with PromptRegistry.isActive()
    """
    canonical = json.dumps(messages, separators=(",", ":"), ensure_ascii=False)
    return bytes(Web3.keccak(text=canonical))


def canonical_hash_hex(messages: list[dict]) -> str:
    """Same as canonical_hash but returns '0x'-prefixed hex string."""
    return "0x" + canonical_hash(messages).hex()


def load_langchain_messages(mcp_spec: dict, prompt_index: int = 0) -> list[dict]:
    """
    Extract langchain_messages from a parsed MCP spec dict.

    Raises ValueError if the field is missing (fail-fast so deployment
    script errors are caught before any PromptRegistry call).
    """
    prompts = mcp_spec.get("prompts", [])
    if not prompts or len(prompts) <= prompt_index:
        raise ValueError(
            f"MCP spec '{mcp_spec.get('name')}' has no prompt at index {prompt_index}"
        )
    msgs = prompts[prompt_index].get("langchain_messages")
    if not msgs:
        raise ValueError(
            f"MCP spec '{mcp_spec.get('name')}' prompt[{prompt_index}] missing 'langchain_messages'"
        )
    return msgs
