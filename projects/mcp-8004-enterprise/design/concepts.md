# R&D Concepts — botman_8004

This repository is a lab for governed agentic workflow patterns built on the ERC-8004 / MCP stack. Each concept layers additional governance on top of the previous ones. All are independently opt-in — removing one does not affect the others.

---

## Concept 1: On-Chain / Off-Chain Hybrid Agent Orchestration

> **Status:** Implemented
> **Design docs:** [architecture.proposal.md](./architecture.proposal.md), [8004.refactor.md](./8004.refactor.md), [mcp.extension.md](./mcp.extension.md)

AI agents are described by machine-readable cards, their capabilities are formalised in MCP specifications, and on-chain Solidity oracle contracts mediate every request and response. The oracle contract is the trust anchor: it records that a request was made, stores the result, and verifies (via the identity registry) that the agent fulfilling the request is the one registered to do so.

**What it achieves:** A fully auditable, on-chain record of every agent action — AML screenings, credit assessments, legal reviews, client setups — with the actual intelligence living off-chain in MCP servers. The ledger proves *what was requested, who answered, and what they said*, without exposing private model weights or business logic. The identity registry design — ERC-721 token, UUPS upgradeability, EIP-712 wallet binding, and reserved metadata keys — is documented in [8004.refactor.md](./8004.refactor.md).

---

## Concept 2: Distributed Tracing

> **Status:** Implemented
> **Design doc:** [distributed_tracing.md](./concepts/distributed_tracing.md)

A `bytes32 traceId` — a correlation token — is born once at the start of an execution chain and propagated unchanged through every on-chain event, bridge invocation, and MCP request until the chain terminates. `ExecutionTraceLog` records ordered hops `(oracle, agentId, action, timestamp)` per traceId. Bridges forward the traceId as an `X-Trace-Id` HTTP header so off-chain server logs are also correlated.

**What it achieves:** The ability to reconstruct a complete, ordered picture of a multi-agent, multi-contract execution — who did what, in what order, across both on-chain and off-chain components — from a single `bytes32` identifier. Answers: *did the chain complete, where did it stall, which agent failed?*

---

## Concept 3: Flow-Scoped Authorization

> **Status:** Implemented
> **Design doc:** [flow-scoped-authorization.md](./concepts/flow-scoped-authorization.md)

Before a flow begins, the orchestrator calls `FlowAuthorizationRegistry.createFlow(traceId, authorizations[])` to declare which agents — identified by their on-chain ERC-8004 agentId — are permitted to exercise which capabilities (`keccak256("aml_review")`, `keccak256("credit_risk")`) within that specific flow. Policies are immutable after creation and remain on-chain as audit records. Oracle contracts check `isAuthorized(traceId, agentId, capability)` before accepting any fulfillment; bridges perform the same check off-chain as a gas-saving pre-flight.

**What it achieves:** Least-privilege enforcement at the flow level. A registered agent cannot act in a flow it was not explicitly authorized for. Different flows can authorize different agent combinations. The *who was allowed* record sits alongside the *what happened* trace on the ledger.

---

## Concept 4: Reputation-Gated Actions

> **Status:** Implemented
> **Design doc:** [reputation-gating.md](./concepts/reputation-gating.md)

`ReputationGate` enforces a quality bar as the fourth authorization layer. Each `bytes32 capability` can have an independent threshold: a minimum average score, a minimum feedback count, and a trusted evaluator list (only feedback from those addresses counts). Before accepting fulfillment, oracle contracts call `reputationGate.meetsThreshold(agentId, capability)`, which queries `ReputationRegistryUpgradeable.getSummary()` with the trusted evaluator list and compares the result against the threshold using decimal-safe cross-multiplication. Bridges perform the same check off-chain. No threshold configured → returns `true` (opt-in).

**What it achieves:** A dynamic quality bar that must be earned before an agent can act. New agents with no history are blocked until they accumulate sufficient positive feedback from trusted evaluators. The bar is per-capability, so a proven reviewer can be held to a different standard than an approver.

---

## Concept 5: Prompt Governance

> **Status:** Implemented
> **Design doc:** [prompt-governance.md](./concepts/prompt-governance.md)

MCP treats prompts as first-class primitives but defines no security properties — no versioning, no hashing, no signatures. ERC-8004 says nothing about prompts at all. In this stack, the agent prompt templates (e.g. `aml_screening`, `credit_assessment`) are static Handlebars strings stored in `agents/mcp/*.mcp.json`; an operator could silently change agent behaviour with no trace anywhere in the governance stack.

`PromptRegistry` closes this gap. It stores `keccak256(templateText)` per `bytes32 capability` on-chain, supports multiple versions, and exposes `isActive(capability, hash) → bool`. Oracle contracts call it as the fifth authorization layer: if the bridge submits an unrecognized hash, the fulfillment reverts with `"unrecognized prompt"`. Bridges compute the hash from the MCP spec file at startup and submit it with every fulfillment. No active version → `isActive` returns `true` (opt-in). Rotating a prompt is a two-step owner transaction: `registerPrompt` + `setActiveVersion`.

**What it achieves:** A tamper-evident, on-chain record of which prompt template version was active at the time of each fulfillment. The hash is stored in the result struct so the full audit trail — *who acted, in what flow, with what reputation, using what prompt* — is readable from the ledger.

---

## Concept 6: Dataset Control

> **Status:** Implemented (on-chain gate + deploy wiring + tests; bridge integration pending)
> **Design doc:** [dataset-control.md](./concepts/dataset-control.md)

AI agents silently consume datasets — training corpora, retrieval indices, few-shot libraries — with no on-chain record of what data informed a decision and no mechanism for a flow initiator to restrict which data may be used. The existing five governance layers prove *who acted, in which flow, with what reputation, using what prompt* — but say nothing about *what data shaped the result*.

`DatasetRegistry` closes this gap with two-tier, opt-in governance. The owner registers datasets into a per-capability global catalogue (keyed by `bytes32 contentHash` — a hash of the actual data, not a URL) and marks entries as globally approved or revoked. The flow initiator then calls `approveForFlow(traceId, contentHashes[])` to declare which catalogue entries are permitted within a specific flow; this policy is immutable once set. Oracle contracts iterate `isApproved(traceId, capability, contentHash)` for every hash submitted in the fulfillment params and revert with `"dataset not approved"` on any failure. The hashes are stored in the result struct alongside the prompt hash and agent identity, completing the audit record.

**What it achieves:** A tamper-evident, on-chain record of which dataset versions were used in each fulfillment, combined with the ability to enforce at fulfillment time that only approved, flow-scoped data was consulted. The full audit trail — *who acted, in what flow, with what reputation, using what prompt, on what data* — is readable from the ledger.

---

## Concept 7: Dynamic Autonomy Bounding

> **Status:** Implemented
> **Design doc:** [dynamic-autonomy-bounding.md](./concepts/dynamic-autonomy-bounding.md)

All previous concepts establish authorization policies that are configured at deploy time and remain static within a flow. They answer whether an agent *may* act — but cannot respond to signals that emerge *during* operation: a reputation score collapsing mid-session, a sudden spike in fulfillment failures, or a latency cliff indicating a degraded model. Once such a signal appears, the only recourse without this concept is manual operator intervention.

Dynamic Autonomy Bounding closes this gap by monitoring three real-time signal types — reputation degradation, anomaly detection (error rate), and performance degradation (success rate) — and automatically revoking or restoring individual tool access as those signals cross declared thresholds.

**The structural novelty is where the thresholds live.** All previous concepts kept their configuration in on-chain contracts. Here, the MCP spec itself is extended: each tool entry in `agents/mcp/*.mcp.json` gains an optional `autonomy_bounds` block declaring signal thresholds per tool. This is not an extension to the MCP *protocol* — the JSON-RPC API is unchanged and MCP clients ignore the extra field. The spec now serves two audiences simultaneously: MCP callers see a standard tool definition; the ERC-8004 governance toolchain reads the threshold configuration. The spec becomes the single source of truth for both what the tool does and what safety limits govern it.

Enforcement lives in the authorization stack, not in the agent's own process (which is untrusted for self-enforcement). `sync-autonomy-bounds.js` reads the reputation thresholds from the spec and loads them into the existing `ReputationGate`. A new `AutonomyBoundsRegistry` contract tracks tool-level enabled/disabled state for the anomaly and performance signals; a trusted off-chain `bounds-monitor.js` process watches oracle fulfillment events, maintains sliding outcome windows, and calls `disableTool`/`enableTool` when thresholds are crossed. Oracle contracts check `isToolEnabled()` as the seventh authorization layer; bridges perform the same check as a gas-saving pre-flight. MCP servers reflect suspended tools in `tools/list` (with `x_suspended: true`) and return error `-32001` on `tools/call` — so callers discover unavailability before attempting a flow.

**What it achieves:** Closed-loop, automatic risk response. An agent whose quality drops is restricted without manual intervention and restored automatically when signals recover. The combination of on-chain enforcement and MCP-level revocation UX means the restriction is visible and auditable at every layer of the stack — from the ledger to the tool catalogue.

---

## Concept 8: Flow-Level Anomaly Detection

> **Status:** Implemented
> **Design doc:** [anomaly-detection.md](./concepts/anomaly-detection.md)

All previous concepts establish authorization policies that answer whether an agent *may* act, or whether its outputs meet quality thresholds. None of them can see **structural failures in the shape of the execution chain itself**: a flow that loops back through the same agent, a trace that accumulates unbounded hops, a burst of requests that saturates an oracle, or a request that simply never receives a response.

Concept 8 closes this gap with four anomaly types split across two enforcement paths. **Loop detection** and **max hops** are enforced directly in `ExecutionTraceLog.recordHop()` as on-chain reverts — the trace log sees every hop across all agents, making it the natural gate. If the same `(oracle, agentId, action)` triple appears twice in a trace when `loopDetectionEnabled` is set, the fulfillment transaction reverts and no partial state lands. If a trace would exceed `maxHopsPerTrace`, the same revert fires. Both policies default to disabled and are configured by the owner via `setMaxHops()` and `setLoopDetection()`.

**Burst detection** and **timeout detection** are inherently time-based and cannot be enforced on-chain. They extend the existing `bounds-monitor.js` off-chain monitor. Burst detection maintains a rolling 60-second request-timestamp buffer per oracle contract; if the count exceeds `max_requests_per_minute` it calls `disableTool()` and recovers automatically via natural decay. Timeout detection tracks every pending request in a `Map` keyed by `requestId`; a `setInterval` sweep every 30 seconds calls `disableTool()` for any request that has waited longer than `response_timeout_seconds`.

**The `flow` signal block** follows the same design principle as the existing `autonomy_bounds` signals: it lives in the MCP spec alongside the tool definition, making the spec the single source of truth for both what the tool does and what structural safety limits govern it. `sync-autonomy-bounds.js` reads the on-chain fields (`max_hops`, `loop_detection`) and configures `ExecutionTraceLog`; `bounds-monitor.js` reads the off-chain fields at startup.

**What it achieves:** Automatic detection and suppression of execution chains that exhibit pathological structure — loops, unbounded growth, overload, or stalls — without requiring changes to oracle contracts, bridge logic, or MCP servers. The existing suspension UX (`x_suspended`, `-32001`) surfaces all four anomaly types uniformly.

---

## Concept 9: Agent Card Integrity

> **Status:** Implemented
> **Design doc:** [identity-gaps.md](./concepts/identity-gaps.md)

Every agent has a `tokenURI` that points to its agent card — the JSON document declaring
its name, capabilities, endpoint, and MCP spec reference. The card is the specification of
what the agent is. Before this concept, nothing on-chain recorded what the card *said*:
an operator could silently rewrite `alice.json` and no event, hash, or revert would signal
the change. From the chain alone you could not reconstruct whether the card at the time of
fulfillment T said capability X was present.

This is the same gap that Concept 5 (Prompt Governance) closed for prompt templates. The
fix follows the same pattern: hash the document, commit the hash on-chain as a reserved
first-class field, and validate the hash at the bridge.

**`cardHash` reserved key.** `IdentityRegistryUpgradeable` gains a third reserved metadata
key — `cardHash` — alongside `agentWallet` and `oracleAddress`. It stores
`keccak256(rawCardFileBytes)` ABI-encoded as `bytes32`. Like the other two reserved keys it
is cleared on token transfer so it cannot persist to a new owner. Generic `setMetadata`
rejects the key with `"reserved key: cardHash"`. The `CardHashSet` event is emitted on
every set and on every transfer-clear.

**Hash convention.** `keccak256` of the raw file bytes as read from disk, with no
normalisation. Any whitespace or formatting change produces a different hash — the hash is
a commitment to an exact byte sequence, not a semantic digest.

**Deploy wiring.** `register-mocks.js` reads the raw card bytes, computes the hash, and
calls `setCardHash(agentId, cardHash)` immediately after the `register()` transaction so
every registered agent enters the registry with a committed hash.

**Bridge startup validation.** Both oracle bridges gain an optional `--identity-registry` /
`IDENTITY_REGISTRY_ADDRESS` argument. When supplied, each bridge computes
`keccak256(rawCardFileBytes)` for its loaded agent card and calls `getCardHash(agentId)`
on-chain. If the on-chain hash is non-zero and differs from the local hash, the bridge logs
a loud `WARNING: card hash mismatch` and continues running.

**Oracle-level enforcement (Concept 9b — implemented).** Every agent-called fulfillment
function in the B2B oracle contracts (`AMLOracle`, `CreditRiskOracle`, `LegalOracle`,
`ClientSetupOracle`) accepts a `bytes32 cardHash_` parameter. Before executing, each
function calls the internal `_checkCardHash(agentId, cardHash_)` helper which reads
`identityRegistry.getCardHash(agentId)` and reverts with `"card hash mismatch"` if the
committed hash is non-zero and differs from the submitted value. Submitting
`bytes32(0)` skips the check (opt-in per agent). Bridges that have a committed card hash
will submit it with every fulfillment transaction, making the card-integrity check fully
per-fulfillment rather than only at startup.

**What it achieves.** A tamper-evident, on-chain commitment to the exact agent card content
that was deployed. Any drift between the running card file and the committed hash is visible
at the next bridge startup. The full identity record — *who the agent is, what wallet it
uses, which oracle it serves, and what card it presented at deploy time* — is readable from
the registry.

---

## Concept 10: Action-Level Authorization

> **Status:** Implemented
> **Design doc:** [action-level-authorization.md](./concepts/action-level-authorization.md)

All nine previous concepts govern whether an agent *may participate* in a flow and whether its outputs meet quality and structural thresholds. None of them govern **what specific operations an agent may perform on external systems** once authorized. An authorized AML agent with `aml_review` capability and sufficient reputation can invoke any tool available to it — including tools that write to a sanctions database, provision client accounts, or execute legal contracts — because the governance stack authorizes *participation*, not *actions*.

Natural language instructions embedded in prompts ("you must never delete backups") are not a security boundary. They are advisory. An LLM can hallucinate, be prompt-injected, misinterpret context, or simply ignore instructions. The gap is structural: between the moment an agent decides to invoke a tool and the moment that invocation reaches an external system, there is no typed, classified, permit-checked enforcement layer.

Action-Level Authorization closes this gap with a four-tier classification system (read-only → reversible write → irreversible/destructive → forbidden) enforced by a new `ActionPermitRegistry` contract on-chain and a **runtime action gateway** off-chain. Every tool invocation routes through the gateway, which parses and classifies the action against a pattern registry, checks the on-chain permit, and blocks or escalates based on tier. Tier 3 (forbidden) actions are hard-blocked with no override. Tier 2 (destructive) actions require multi-agent or human-in-the-loop approval before execution — only the specific invocation is paused, not the entire flow. Tier 1 (reversible write) actions require an explicit permit. Tier 0 (read-only) actions fall back to flow authorization.

The MCP spec gains an optional `action_permits` block per tool (following the same pattern as `autonomy_bounds` and `flow` signal blocks), making the spec the single source of truth for what the tool does and what actions it may perform. Violation signals (blocked or unpermitted actions) feed into the existing reputation and autonomy bounding systems: repeated violations reduce reputation scores and trigger `disableTool()`.

**What it achieves:** A structural enforcement layer between agent intent and external system access. The LLM can reason about any action — the enforcement is structural, not conversational. Instructions in prompts remain useful as guidance; safety-critical boundaries are enforced by code that the agent cannot bypass, override, or hallucinate around. The full audit trail — *who acted, in what flow, with what reputation, using what prompt, on what data, within what autonomy bounds, with what structural safeguards, with what card identity, **and what actions were permitted, attempted, blocked, or approved*** — is readable from the ledger.

---

## Identity and Risk Management Stack Summary

| Capability     | Layer                     | Contract                                                         | Question answered                                                                                   |
|----------------|---------------------------|------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| Identity       | Registration              | `IdentityRegistryUpgradeable`                                    | Does this agent exist and are its wallet and oracle registered?                                     |
| Risk Management | Tracing                   | `ExecutionTraceLog`                                              | What did this agent do, in what order, and across which contracts?                                  |
| Risk Management | Flow authorization        | `FlowAuthorizationRegistry`                                      | Is this agent permitted to act in **this specific flow**?                                           |
| Risk Management | Reputation gating         | `ReputationGate`                                                 | Has this agent **earned the right** to perform this capability?                                     |
| Risk Management | Prompt governance         | `PromptRegistry`                                                 | Is the agent using the **current approved prompt template**?                                        |
| Risk Management | Dataset control           | `DatasetRegistry`                                                | Did the agent use only **registered, flow-approved datasets**?                                      |
| Risk Management | Dynamic Autonomy bounding | `AutonomyBoundsRegistry`                                         | Is this tool currently **within operating bounds** based on live signals?                           |
| Risk Management | Flow anomaly detection    | `ExecutionTraceLog` (on-chain) + `bounds-monitor.js` (off-chain) | Does this flow exhibit **structural anomalies** — loops, runaway depth, bursts, or stuck responses? |
| Identity | Card Integrity            | `IdentityRegistryUpgradeable`                                    | Does the agent card content match what was **committed at deploy time?**                            |
| Risk Management | Action-level authorization | `ActionPermitRegistry` (on-chain) + runtime action gateway (off-chain) | Is this agent permitted to perform **this specific action** on this external system in this flow? |

Each layer is opt-in. Setting the relevant address to `address(0)` (or omitting it from the deploy) disables that layer with no gas overhead beyond a single `ISZERO` check.
