"""
prompt_verifier.py — LangSmith prompt fetch + on-chain hash verification.

Mirrors the logic in examples/prompt_registry/bridge/runtime_verifier.py but
is wired into bridge_base.py's bootstrap_bridge() so every bridge can verify
its prompt template at startup without duplicating the logic.

Environment variables:
    LANGCHAIN_API_KEY   LangSmith API key (required when PROMPT_REGISTRY_ADDRESS is set)
    LANGCHAIN_ENDPOINT  LangSmith endpoint (optional)
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

from web3 import Web3

logger = logging.getLogger(__name__)


class PromptTamperError(RuntimeError):
    """Raised when the fetched prompt does not match the on-chain registered hash."""


# ── Canonical serialization ────────────────────────────────────────────────────

def _serialize_prompt(prompt_template: Any) -> str:
    """Deterministic JSON representation of a LangChain prompt template."""
    try:
        messages = []
        for msg in prompt_template.messages:
            messages.append({
                "type": type(msg).__name__,
                "content": msg.prompt.template if hasattr(msg, "prompt") else str(msg),
            })
        return json.dumps({"messages": messages}, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    except AttributeError:
        return json.dumps({"template": prompt_template.template}, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def compute_content_hash(prompt_template: Any) -> bytes:
    """Return the keccak256 hash of the canonical prompt content."""
    return Web3.keccak(text=_serialize_prompt(prompt_template))


def prompt_id_bytes32(prompt_name: str) -> bytes:
    """Derive the on-chain bytes32 promptId from a prompt name string."""
    return Web3.keccak(text=prompt_name)


# ── On-chain verification ─────────────────────────────────────────────────────

PROMPT_REGISTRY_VERIFY_ABI = [
    {
        "name": "verify",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "promptId",    "type": "bytes32"},
            {"name": "version",     "type": "string"},
            {"name": "contentHash", "type": "bytes32"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "name": "getHash",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "promptId", "type": "bytes32"},
            {"name": "version",  "type": "string"},
        ],
        "outputs": [{"name": "", "type": "bytes32"}],
    },
]


async def verify_prompt_at_startup(
    label: str,
    w3: Any,
    *,
    registry_address: str,
    prompt_name: str,
    prompt_version: str,
) -> None:
    """
    Fetch a prompt from LangSmith, recompute its keccak256, and verify against
    the on-chain PromptRegistry. Logs a warning on mismatch (non-fatal at startup
    to match the card-hash check pattern in bridge_base.py).

    Raises PromptTamperError only if the registry has a registered hash AND it
    does not match — indicating active tampering. A missing registration is
    treated as a warning (the registry may not be populated yet in dev).
    """
    try:
        from langsmith import Client
    except ImportError:
        logger.warning("[%s] langsmith not installed — skipping prompt hash check", label)
        return

    try:
        client = Client()
        prompt_template = client.pull_prompt(f"{prompt_name}:{prompt_version}")
        content_hash = compute_content_hash(prompt_template)
        p_id = prompt_id_bytes32(prompt_name)

        registry = w3.eth.contract(
            address=Web3.to_checksum_address(registry_address),
            abi=PROMPT_REGISTRY_VERIFY_ABI,
        )

        on_chain: bytes = await registry.functions.getHash(p_id, prompt_version).call()
        zero = b"\x00" * 32

        if on_chain == zero:
            logger.warning(
                "[%s] Prompt '%s:%s' not registered on-chain — run registry_bridge.py",
                label, prompt_name, prompt_version,
            )
            return

        computed_hex  = "0x" + content_hash.hex()
        on_chain_hex  = "0x" + on_chain.hex()

        if on_chain_hex.lower() != computed_hex.lower():
            raise PromptTamperError(
                f"[{label}] Prompt hash mismatch for '{prompt_name}:{prompt_version}'. "
                f"On-chain: {on_chain_hex} | Computed: {computed_hex}. "
                "Prompt may have been modified after on-chain registration."
            )

        logger.info(
            "[%s] Prompt hash OK '%s:%s': %s",
            label, prompt_name, prompt_version, computed_hex,
        )

    except PromptTamperError:
        raise
    except Exception as exc:
        logger.warning("[%s] Prompt hash check failed (non-fatal): %s", label, exc)
