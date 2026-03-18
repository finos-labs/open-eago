"""
langsmith_client.py — local prompt loading, LangSmith push/pull, and keccak256 hashing.

Source of truth flow:
  prompts/<agent>.yaml  →  push_to_langsmith()  →  LangSmith (versioned delivery)
                        →  compute_hash()        →  on-chain PromptRegistry

Runtime verification flow:
  LangSmith (name:commit)  →  fetch_and_hash()  →  compare with on-chain hash

Environment variables:
    LANGCHAIN_API_KEY   LangSmith API key
    LANGCHAIN_ENDPOINT  LangSmith endpoint (optional)
"""

import json
from pathlib import Path
from typing import Any

import yaml
from web3 import Web3

PROMPTS_DIR = Path(__file__).parent.parent / "prompts"


# ── Canonical serialization ────────────────────────────────────────────────────

def _canonical(messages: list[dict]) -> str:
    """Deterministic JSON serialization of a messages list (sorted keys, no whitespace)."""
    return json.dumps({"messages": messages}, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


# ── Local file loading ─────────────────────────────────────────────────────────

def load_local_prompt(prompt_name: str) -> tuple[dict, str, bytes]:
    """
    Load a prompt from prompts/<prompt_name>.yaml.

    Returns:
        spec:             Parsed YAML dict (name, description, version, messages).
        canonical:        Deterministic JSON string used for hashing.
        content_hash:     32-byte keccak256 of canonical.
    """
    path = PROMPTS_DIR / f"{prompt_name}.yaml"
    if not path.exists():
        raise FileNotFoundError(f"Prompt file not found: {path}")

    spec = yaml.safe_load(path.read_text(encoding="utf-8"))
    messages = spec.get("messages", [])
    canonical = _canonical(messages)
    content_hash: bytes = Web3.keccak(text=canonical)
    return spec, canonical, content_hash


# ── LangSmith push ────────────────────────────────────────────────────────────

def push_to_langsmith(spec: dict) -> str:
    """
    Push a local prompt spec to LangSmith and return the commit hash.

    Args:
        spec:  Parsed prompt YAML (must have 'name' and 'messages' keys).

    Returns:
        The LangSmith commit hash string for the pushed version.
    """
    from langchain_core.prompts import ChatPromptTemplate
    from langsmith import Client

    messages = [(m["role"], m["content"]) for m in spec["messages"]]
    template = ChatPromptTemplate.from_messages(messages)

    client = Client()
    url = client.push_prompt(spec["name"], object=template)
    # url is of the form https://smith.langchain.com/prompts/<name>/<commit>
    commit = url.rstrip("/").split("/")[-1]
    return commit


# ── LangSmith pull + hash ─────────────────────────────────────────────────────

def fetch_and_hash(prompt_name: str, commit_or_tag: str) -> tuple[str, bytes]:
    """
    Pull a prompt from LangSmith and return (canonical_content, keccak256_hash).
    Used by runtime_verifier to re-verify against the on-chain hash.

    Args:
        prompt_name:    LangSmith prompt name (e.g. "bank-aml-agent").
        commit_or_tag:  LangSmith commit hash or tag.

    Returns:
        canonical_content: The string that was hashed (useful for debugging).
        content_hash:      32-byte keccak256 digest.
    """
    from langsmith import Client

    client = Client()
    prompt_template = client.pull_prompt(f"{prompt_name}:{commit_or_tag}")
    messages = _extract_messages(prompt_template)
    canonical = _canonical(messages)
    content_hash: bytes = Web3.keccak(text=canonical)
    return canonical, content_hash


def _extract_messages(prompt_template: Any) -> list[dict]:
    """Extract a normalized messages list from a LangChain prompt template."""
    try:
        return [
            {
                "role": type(msg).__name__.replace("MessagePromptTemplate", "").lower(),
                "content": msg.prompt.template if hasattr(msg, "prompt") else str(msg),
            }
            for msg in prompt_template.messages
        ]
    except AttributeError:
        return [{"role": "human", "content": prompt_template.template}]


# ── Shared helpers ────────────────────────────────────────────────────────────

def prompt_id_bytes32(prompt_name: str) -> bytes:
    """Derive the on-chain bytes32 promptId from a prompt name."""
    return Web3.keccak(text=prompt_name)
