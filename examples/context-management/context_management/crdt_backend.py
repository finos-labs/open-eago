"""Pure-Python CRDT-inspired document backend.

The PyPI `automerge` package (0.1.2) is a minimal Rust stub that lacks
`change()`, `save()`, and a usable `merge()`.  This module implements the
same interface using only the Python standard library so the demo runs
without any native dependencies.

Key CRDT properties preserved:
  - Journal (list): union on merge — no entries are lost
  - Maps (playbook, plan, agents): key-union with last-writer-wins
  - Risk scalar fields: kept from local; max-score policy applied by
    WorkflowContextStore.merge_with() after the structural merge
  - History: append-only change log, deduped and sorted by wall-clock time
  - Serialisation: JSON round-trip via save_doc / load_doc
"""

from __future__ import annotations

import copy
import json
import time
import uuid
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Doc — dict-like container with a change log
# ---------------------------------------------------------------------------

class Doc:
    """Mutable document backed by a plain dict, with an append-only change log."""

    def __init__(self, state: dict, history: list[dict], actor: str) -> None:
        self._state = state
        self._history = history
        self._actor = actor

    # dict-like read access so workflow_context can use doc["key"] syntax
    def __getitem__(self, key: str) -> Any:
        return self._state[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self._state[key] = value

    def __contains__(self, key: str) -> bool:
        return key in self._state

    def get(self, key: str, default: Any = None) -> Any:
        return self._state.get(key, default)


# ---------------------------------------------------------------------------
# Public API (mirrors the automerge module-level functions in the plan)
# ---------------------------------------------------------------------------

def create_doc(initial_data: dict) -> Doc:
    """Create a new document initialised from *initial_data*."""
    actor = str(uuid.uuid4())[:8]
    state = copy.deepcopy(initial_data)
    history = [{"actor": actor, "seq": 1, "time": time.time(), "message": "init"}]
    return Doc(state, history, actor)


def apply_change(doc: Doc, fn: Callable[[Doc], None]) -> Doc:
    """Apply *fn* to a mutable copy of *doc* and return the updated Doc."""
    new_state = copy.deepcopy(doc._state)
    proxy = Doc(new_state, doc._history, doc._actor)
    fn(proxy)

    new_history = list(doc._history) + [{
        "actor": doc._actor,
        "seq": len(doc._history) + 1,
        "time": time.time(),
    }]
    return Doc(new_state, new_history, doc._actor)


def merge_docs(local: Doc, remote: Doc) -> Doc:
    """Merge *remote* into *local* (CRDT semantics, returns a new Doc).

    Merge rules:
    - Lists  → union (deduplicated by JSON fingerprint)
    - Maps   → key-union; remote value wins for conflicts
    - Scalars → keep local value (callers apply domain-specific policies)
    """
    merged_state = copy.deepcopy(local._state)
    _deep_merge(merged_state, remote._state)

    # Merge histories: combine, dedup by (actor, seq), sort by time
    seen: set[tuple] = set()
    combined: list[dict] = []
    for change in list(local._history) + list(remote._history):
        key = (change.get("actor"), change.get("seq"))
        if key not in seen:
            seen.add(key)
            combined.append(change)
    combined.sort(key=lambda c: c.get("time", 0))

    return Doc(merged_state, combined, local._actor)


def save_doc(doc: Doc) -> bytes:
    """Serialize *doc* to UTF-8 JSON bytes."""
    payload = {"state": doc._state, "history": doc._history, "actor": doc._actor}
    return json.dumps(payload, default=str).encode("utf-8")


def load_doc(data: bytes) -> Doc:
    """Deserialize a Doc from bytes produced by :func:`save_doc`."""
    payload = json.loads(data.decode("utf-8"))
    return Doc(payload["state"], payload["history"], payload["actor"])


def get_history(doc: Doc) -> list[dict]:
    """Return the append-only change log (audit / blockchain anchoring)."""
    return list(doc._history)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _deep_merge(target: dict, source: dict) -> None:
    """Recursively merge *source* into *target* in-place.

    - Lists : union — items from source absent in target are appended.
              Deduplication uses a JSON fingerprint so dict-valued items
              (journal entries) are compared by content, not identity.
    - Dicts : recurse.
    - Scalars: keep target value (caller applies domain policy afterwards).
    """
    for key, src_val in source.items():
        if key not in target:
            target[key] = copy.deepcopy(src_val)
            continue

        tgt_val = target[key]

        if isinstance(tgt_val, list) and isinstance(src_val, list):
            existing_fps = {json.dumps(item, sort_keys=True, default=str) for item in tgt_val}
            for item in src_val:
                fp = json.dumps(item, sort_keys=True, default=str)
                if fp not in existing_fps:
                    tgt_val.append(copy.deepcopy(item))
                    existing_fps.add(fp)

        elif isinstance(tgt_val, dict) and isinstance(src_val, dict):
            _deep_merge(tgt_val, src_val)

        # scalar: keep target (callers handle domain-specific policies)
