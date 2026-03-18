"""
langsmith_client.py — fetch a prompt from LangSmith and compute its keccak256 hash.

The hash is computed over a deterministic canonical JSON serialization of the
prompt's messages, making it suitable for on-chain registration and verification.

Environment variables:
    LANGCHAIN_API_KEY   LangSmith API key (required)
    LANGCHAIN_ENDPOINT  LangSmith endpoint (optional, defaults to smith.langchain.com)
"""

import json
import os
from typing import Any

from langsmith import Client
from web3 import Web3


def _canonical(obj: Any) -> str:
    """Deterministic JSON serialization (sorted keys, no extra whitespace)."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def _serialize_prompt(prompt_template) -> str:
    """
    Extract a stable string representation of a LangChain prompt template.
    Works for ChatPromptTemplate and PromptTemplate.
    """
    try:
        # ChatPromptTemplate: serialize each message's type + content
        messages = []
        for msg in prompt_template.messages:
            messages.append({
                "type": type(msg).__name__,
                "content": msg.prompt.template if hasattr(msg, "prompt") else str(msg),
            })
        return _canonical({"messages": messages})
    except AttributeError:
        # Fallback for simple PromptTemplate
        return _canonical({"template": prompt_template.template})


def fetch_and_hash(prompt_name: str, commit_or_tag: str) -> tuple[str, bytes]:
    """
    Pull a prompt from LangSmith and return (canonical_content, keccak256_hash).

    Args:
        prompt_name:    LangSmith prompt name (e.g. "aml-review-agent").
        commit_or_tag:  LangSmith commit hash or tag (e.g. "abc123" or "production").

    Returns:
        canonical_content: The string that was hashed (useful for debugging).
        content_hash:      32-byte keccak256 digest, ready for on-chain registration.
    """
    client = Client()
    identifier = f"{prompt_name}:{commit_or_tag}"
    prompt_template = client.pull_prompt(identifier)

    canonical_content = _serialize_prompt(prompt_template)
    content_hash: bytes = Web3.keccak(text=canonical_content)
    return canonical_content, content_hash


def prompt_id_bytes32(prompt_name: str) -> bytes:
    """Derive the on-chain bytes32 promptId from a prompt name."""
    return Web3.keccak(text=prompt_name)
