# Design: Flow-Scoped Authorization for ERC-8004 Agent Workflows

## Problem

In an enterprise agentic workflow, multiple agents collaborate across a traced execution flow. Currently, any registered agent can participate in any flow or perform any task. We need a mechanism to ensure that **only agents explicitly authorized for a given flow — and for specific roles within that flow — are permitted to act**.

## Core Concept

We introduce a **Flow Authorization Registry** that works alongside the existing `ExecutionTraceLog`. When a flow is initiated, the initiator declares:

1. **Which agents** (by their on-chain identity/address) are authorized to participate.
2. **Which capabilities** each agent is allowed to exercise within that flow (e.g., `review_code`, `approve_pr`).

Every subsequent on-chain action (oracle request, trace event emission) is gated by a check against this authorization list.

## Architecture Components

### 1. Flow Policy (On-Chain)

When a new `traceId` is created, the initiator registers a **flow policy** — a mapping of agent addresses to their permitted capabilities for that specific flow. This is stored on-chain and becomes immutable once the flow begins execution.

### 2. Authorization Checks

All existing contracts (`CodeReviewerOracle`, `CodeApproverOracle`, `ExecutionTraceLog`) are extended with a modifier that, before processing any request, verifies:

- The calling agent is listed in the flow policy for the given `traceId`.
- The calling agent holds the required capability for the action being performed (e.g., only a `review_code`-authorized agent can submit a review request).

### 3. Bridge-Level Enforcement

The off-chain bridges also enforce authorization before relaying responses back on-chain. This provides a **defense-in-depth** approach — even if a bridge is compromised, the on-chain modifier will reject unauthorized submissions.

### 4. Capability Model

Capabilities are derived directly from the MCP specifications already defined in agent cards. Each agent card declares capabilities like `review_code` or `approve_pr`. These capability strings are hashed and stored on-chain as `bytes32` identifiers for gas-efficient comparison.

## Flow Lifecycle

1. **Flow Creation**: An orchestrator calls `createFlow(traceId, AuthorizationEntry[])` where each entry is `{ uint256 agentId, bytes32[] capabilities }` — using on-chain NFT IDs, not addresses, so authorization is tied to the registered identity rather than a wallet that could be rotated.
2. **Execution**: As agents interact (submitting reviews, approvals, etc.), each on-chain call is checked against the flow policy. Unauthorized calls revert with a descriptive error.
3. **Flow Completion**: When the flow ends, the policy remains on-chain as an immutable audit record of who was authorized to do what.

## Why This Fits the Enterprise Model

- **Least Privilege**: Agents only get the permissions they need for a specific workflow instance — not blanket access to all flows.
- **Auditability**: The authorization policy is recorded on-chain alongside the execution trace, providing a complete picture of *who was allowed* and *what they actually did*.
- **Flexibility**: Different flows can authorize different agent combinations. A high-risk code change might require two reviewers and two approvers, while a low-risk change needs only one of each.
- **Compatibility**: This builds on top of the existing `ExecutionTraceLog` tracing system and the `IdentityRegistry` agent registration — it doesn't replace them, it layers authorization on top.

## Relationship to Existing Components

| Component | Role |
|---|---|
| **IdentityRegistry** | Registers agents globally (identity, metadata, oracle addresses) |
| **ExecutionTraceLog** | Records what happened in a flow (trace events with `traceId` / `spanId`) |
| **Flow Authorization** *(new)* | Controls who is **allowed** to act in a specific flow instance |
| **ReputationRegistry** | Tracks agent reputation scores over time |

The authorization layer sits between identity (who exists) and tracing (what happened), answering the question:
**who was permitted to act?**

## B2B Extension: Bilateral Consent (P2a)

In a cross-bank deployment, `createFlow` is unilateral — the flow initiator (Bank A) declares which agents may participate, including Bank B's agents. For cross-institutional flows this requires bilateral consent: Bank B must independently authorize its own agents' participation.

`authorizeAgentForFlow(flowId, agentId, capabilities[])` provides this mechanism. When a `ParticipantRegistry` is configured, the function enforces that `msg.sender` is a registered minter of the institution that owns `agentId` (verified via the agent's `participantId` metadata). Bank B can only add Bank B's agents; Bank A cannot consent on Bank B's behalf.