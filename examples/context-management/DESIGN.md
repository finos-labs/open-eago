# Context Management — Design Document

## 1. What Problem Are We Solving?

OpenEAGO workflows involve many agents running in parallel — a requirements analyst, an architect, a security reviewer, and more can all be reading and writing shared workflow state at the same time.  A naive approach (one shared dict, one database row, one LangGraph state object behind a single checkpointer) serialises every write through a central lock.  That bottleneck becomes the ceiling on how fast a workflow can move.

Beyond throughput, enterprise deployments have a second hard requirement: every state change must be auditable.  Who wrote what, when, and in what order must be reconstructable after the fact — for SOC 2 reviews, incident postmortems, and blockchain anchoring of compliance evidence.

This implementation addresses both concerns together.

---

## 2. What Is a CRDT?

**CRDT** stands for **Conflict-free Replicated Data Type**.

A CRDT is a data structure designed so that any number of independent copies (replicas) can accept writes concurrently, and those replicas can always be merged into a single consistent result — **without coordination, without locks, and without any replica ever having to "win" a conflict by discarding another's work**.

The key mathematical property is **commutativity and idempotency of the merge operation**:

```
merge(A, B) == merge(B, A)          # order doesn't matter
merge(A, merge(A, B)) == merge(A, B) # applying the same change twice is safe
```

Because merge is always safe to call, replicas can exchange state in any order, over unreliable networks, with arbitrary delays, and the result will still converge to the same value everywhere.

### Two flavours relevant here

| Type | Behaviour | Used for |
|---|---|---|
| **Grow-only set / append-only list** | Items can only be added, never removed. Any union of two replicas contains all items from both. | `journal` — audit events |
| **Last-write-wins map (LWW-Map)** | For each key, the value with the most recent timestamp wins. New keys from either replica are always kept. | `playbook`, `agents`, `plan` |

The `risk.composite_score` field uses neither of the above.  Instead it applies a **domain-specific merge policy** (max-score) layered on top of the structural CRDT merge, because the risk-conservative choice for a compliance system is always to surface the highest score observed across any replica.

---

## 3. Why CRDTs for OpenEAGO?

### Alternative 1 — Shared mutable state (plain dict / database row)

Every agent read and write goes through a single object.  Simple to reason about, but:

- Requires a distributed lock or serialisable transaction for every mutation.
- One slow or failed agent can block all others.
- No built-in history; audit log must be added separately.

### Alternative 2 — Hybrid graph + database

A graph database stores the workflow DAG; a relational database stores state.  Richer query capability, but:

- Two systems to keep in sync, two failure modes.
- Merge logic becomes application-level SQL/Cypher, easy to get wrong under concurrency.
- Still needs locking for concurrent writes to the same node.

### Alternative 3 (chosen) — CRDT + event sourcing

Each agent holds its own replica of the workflow context document.  Writes are local and instant.  When agents synchronise, replicas are merged deterministically.  An append-only change log is a by-product of every mutation.

This fits OpenEAGO's needs precisely:

| Requirement | How CRDTs satisfy it |
|---|---|
| Dozens of agents writing in parallel | Replicas diverge safely; no lock contention |
| Eventual consistency acceptable | CRDT guarantee: all replicas converge after any merge |
| Append-only audit log | The change history is intrinsic to the CRDT document |
| Blockchain anchoring | `save()` produces a deterministic byte blob; hash it and anchor |
| Resume after failure | Deserialise the last checkpoint; replay is automatic |
| No LangGraph coupling | Standalone Python; export to LangGraph state is a one-liner |

---

## 4. How It Works — Layer by Layer

```
┌─────────────────────────────────────────────────────┐
│  demo.py  /  agent code                             │  consumers
├─────────────────────────────────────────────────────┤
│  WorkflowContextStore   (workflow_context.py)       │  high-level API
│  WorkflowContext / RiskContext / JournalEntry       │
│                         (models.py)                 │  typed snapshots
├─────────────────────────────────────────────────────┤
│  crdt_backend.py                                    │  CRDT primitives
│  Doc · create_doc · apply_change · merge_docs       │
│  save_doc · load_doc · get_history                  │
└─────────────────────────────────────────────────────┘
```

### 4.1 `crdt_backend.py` — CRDT primitives

`Doc` is a plain Python object wrapping a dict (`_state`) and a list of change records (`_history`).  It exposes dict-like access (`doc["key"]`) so mutation lambdas can stay readable.

Every mutation goes through `apply_change(doc, fn) -> Doc`:

```python
def apply_change(doc: Doc, fn: Callable[[Doc], None]) -> Doc:
    new_state = copy.deepcopy(doc._state)   # snapshot
    proxy = Doc(new_state, ...)
    fn(proxy)                               # mutate the copy
    new_history = doc._history + [change_record]
    return Doc(new_state, new_history, ...)
```

The original doc is never mutated.  Each call returns a new Doc.  This is the same functional update pattern used by Automerge, Redux, and Elixir's immutable data structures.

`merge_docs(local, remote) -> Doc` implements the structural CRDT merge:

```
For each field in the document:
  list   → union  (items from remote not in local are appended;
                   deduplication uses a JSON fingerprint of the whole item)
  dict   → recurse (key-union; remote value wins for map conflicts)
  scalar → keep local (domain policies applied by the caller afterwards)
```

The change histories are also merged: entries from both replicas are combined, deduplicated by `(actor, seq)`, and sorted by wall-clock time.

### 4.2 `models.py` — Pydantic types

`WorkflowContext` is a **read-only snapshot** — a Pydantic `BaseModel` built from the CRDT doc on demand.  Agents never mutate it; they call methods on `WorkflowContextStore` instead.

`RiskContext` encodes the normative OpenEAGO risk taxonomy:

```
composite_score = financial×0.25 + operational×0.20
                + compliance×0.30 + security×0.25
```

Thresholds map score to tier: `< 0.40` → low, `< 0.60` → medium, `< 0.80` → high, `≥ 0.80` → critical.  These constants come from `docs/overview/risk-management.md` and are not configurable at runtime.

### 4.3 `workflow_context.py` — `WorkflowContextStore`

The store is the only interface agents interact with.  Every write method wraps a single `apply_change` call:

| Method | CRDT behaviour |
|---|---|
| `append_journal(entry)` | List append — naturally grows-only, merge is union |
| `upsert_playbook(key, value)` | Map assignment — last-write-wins on merge |
| `update_risk(dimensions, event)` | Computes score locally; max-score enforced at merge time |
| `update_plan(patch)` | Shallow-merge patch into plan map |
| `register_agent(id, metadata)` | Map upsert |

`merge_with(other)` is where the two layers compose:

```python
def merge_with(self, other):
    # Step 1: structural CRDT merge (list union + map key-union)
    self._doc = merge_docs(self._doc, other._doc)

    # Step 2: domain policy — risk is conservative, so take the max score
    if other_score > local_score:
        self._doc = apply_change(self._doc, lambda doc: set_max_score(...))
```

`snapshot()` converts the live CRDT doc into a validated, immutable `WorkflowContext` for safe consumption by read-only code or serialisation to JSON.

`save()` / `load()` provide a JSON byte blob that can be:
- Stored as a checkpoint between workflow phases.
- Hashed and anchored to a blockchain for compliance evidence.
- Sent over a message bus to synchronise replicas across machines.

---

## 5. Demonstrated Properties (from `demo.py`)

The demo runs a three-agent SDLC scenario — requirements analyst, architect, security reviewer — all forked from the same initial state, working without coordination, then merged:

| Assertion | What it proves |
|---|---|
| `len(journal) == 6` | No writes lost: all 6 events (2 per agent) survive the double merge |
| `score == max(score_a, score_b, score_c)` | Max-score policy: the most conservative risk reading wins |
| `tier == score_to_tier(max_score)` | Tier derives from score, not from whichever replica happened to be "local" |
| `playbook.keys() == {"requirements", "design", "security"}` | Map union: all three agents' entries are present |
| Roundtrip: `load(save()).snapshot() == snapshot()` | Serialisation is lossless |
| `len(history) == 8` | Append-only change log accumulates across all agents and merges |

---

## 6. Extension Points

**Swap in real Automerge.**  `crdt_backend.py` is intentionally isolated.  When the `automerge` Python bindings mature (the Rust library is production-grade; the Python wrapper was a stub as of March 2026), only `crdt_backend.py` changes — `workflow_context.py`, `models.py`, and all agent code stay the same.

**LangGraph interop.**  `WorkflowContextStore.snapshot()` returns a Pydantic model.  A LangGraph custom checkpointer adapter needs only to call `store.save()` on `on_step_end` and `WorkflowContextStore.load(data)` on `on_step_start`.

**Blockchain anchoring.**  `store.save()` returns a deterministic byte blob.  Hash it with SHA-256 and write the hash to an on-chain audit contract.  The full blob can be stored off-chain (IPFS, S3) with the hash as the pointer.

**Multi-node distribution.**  Replicas can be exchanged over any transport (HTTP, message queue, gRPC).  The receiving node calls `store.merge_with(received_store)`.  No coordinator required.
