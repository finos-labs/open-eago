# Architecture Proposal: On-Chain Agent Orchestration via MCP

> **Date:** February 21, 2026  
> **Project:** botman_8004  
> **Status:** Prototype / In Progress

---

## 1. Overview

This document captures the full body of architectural work completed to design and implement a system where **AI agents are described by machine-readable cards**, their **capabilities are formalised in MCP specifications**, and **on-chain Solidity contracts delegate execution to those agents** via an oracle-like bridge pattern.

The result is a traceable, auditable pipeline where every agent action — a code review, an approval decision — is requested and recorded on-chain, while the actual intelligence lives off-chain in MCP servers.

---

## 2. The Pipeline

```
Agent Card (JSON)
      │
      │  links to
      ▼
MCP Specification (JSON)
      │
      ├──[codegen]──▶  Solidity Oracle Contract   (on-chain request/response)
      ├──[codegen]──▶  MCP Server                 (off-chain tool/resource/prompt implementation)
      └──[codegen]──▶  Oracle Bridge              (event watcher + tx submitter)
```

Each layer is a direct mechanical derivation of the MCP spec — the same schema drives all three artefacts. Adding a new agent type means writing a new MCP spec; everything else can be regenerated from it.

---

## 3. Agent Cards

**Location:** `agents/*.json`

Each agent is described by a JSON card. Cards are the entry point for the entire system — they declare identity, capabilities, network endpoint, and a pointer to the MCP spec that governs the agent's behaviour.

### Agent Roles

| Agent | File | Role | Port | MCP Spec |
|---|---|---|---|---|
| CodeReviewerAlice | `alice.json` | Code reviewer | 8001 | `code-reviewer.mcp.json` |
| CodeReviewerBob   | `bob.json`   | Code reviewer | 8002 | `code-reviewer.mcp.json` |
| CodeApproverDave  | `dave.json`  | Code approver | 8003 | `code-approver.mcp.json` |
| CodeApproverEve   | `eve.json`   | Code approver | 8004 | `code-approver.mcp.json` |

### Card Schema

```json
{
  "name":        "CodeReviewerAlice",
  "description": "Reviews code for bugs",
  "capabilities": ["code-review"],
  "endpoint":    "http://localhost:8001",
  "image":       "https://example.com/alice.png",
  "mcpSpec":     "./mcp/code-reviewer.mcp.json"
}
```

Key fields:
- **`capabilities`** — drives which server script is spawned (`code-review` → `code-reviewer-server.js`, `approve-pr` → `code-approver-server.js`)
- **`endpoint`** — the port the MCP server will listen on; read directly by `launch-agents.js` / `launch-agents.ps1`
- **`mcpSpec`** — relative path to the MCP specification that defines this agent's tools, resources, and prompts

---

## 4. MCP Specifications

**Location:** `agents/mcp/*.mcp.json`

MCP (Model Context Protocol) is the specification format that describes what an agent can do. It defines three primitive types:

| Primitive | Purpose | On-chain mapping |
|---|---|---|
| **Tools** | Executable functions with typed input/output schemas | `request*()` + `fulfill*()` function pairs |
| **Resources** | Read-only data identified by URI | `mapping(key → bytes)` storage + getter |
| **Prompts** | Pre-defined LLM instruction templates with arguments | Loaded as system prompt in MCP server; not stored on-chain |

### 4.1 `code-reviewer.mcp.json`

Governs Alice and Bob.

**Tools:**
- `review_pr(pr_id, focus[])` → `{ pr_id, summary, comments[], approved }` — performs the review
- `get_review_status(pr_id)` → current status and existing comments

**Resources:**
- `review://{pr_id}/comments` — all review comments for a PR (JSON)
- `review://{pr_id}/diff` — raw unified diff of the PR (text)

**Prompts:**
- `code_review(pr_id, language?, focus?)` — instructs the LLM to analyse the diff, produce per-line structured feedback (file, line, severity, category, message, suggestion), and end with APPROVE or REQUEST_CHANGES

### 4.2 `code-approver.mcp.json`

Governs Dave and Eve.

**Tools:**
- `approve_pr(pr_id, reviewer_agent?, message?)` → `{ pr_id, decision, reason, unresolved_blockers[] }` — issues an approval decision after checking reviewer output
- `reject_pr(pr_id, reason)` — outright rejects a PR

**Resources:**
- `review://{pr_id}/comments` — reviewer comments used as input for the decision (proxied from reviewer agent)
- `approval://{pr_id}/decision` — the stored approval/rejection decision

**Prompts:**
- `approve_pr_prompt(pr_id, reviewer_summary?)` — instructs the LLM to fetch review comments, identify unresolved blockers, and call the appropriate tool

---

## 5. On-Chain Oracle Contracts

**Location:** `contracts/CodeReviewerOracle.sol`, `contracts/CodeApproverOracle.sol`

### Design Principles

- **Request/response pattern** — every tool call is a two-step on-chain lifecycle: request (emits event) → fulfillment (oracle callback)
- **Raw bytes storage** — all payloads (`summary`, `comments`, `reason`, `unresolved_blockers`) are stored as raw `bytes` (serialised JSON). This keeps gas low, keeps the contract schema-agnostic, and delegates serialisation to the off-chain layer.
- **Identity-registry authorization** — oracle contracts do not maintain their own whitelist. Authorization is fully delegated to `IdentityRegistryUpgradeable` via the `onlyRegisteredOracle(agentId)` modifier (see section 11 for full rationale).
- **Unique request IDs** — `requestId = keccak256(requester, prId, timestamp, nonce)` — collision-resistant, deterministic, no external randomness needed.
- **MCP resource mirroring** — every MCP resource URI maps to a `mapping` on-chain, updated on each fulfillment, readable by any caller.
- **Result attribution** — every fulfilled result stores the `agentId` of the oracle that produced it, creating a permanent on-chain link to the registered agent identity.

### 5.1 `CodeReviewerOracle.sol`

Derived from `code-reviewer.mcp.json`.

```
State
  mapping(bytes32 → ReviewRequest)   requests         // request metadata
  mapping(bytes32 → ReviewResult)    results          // fulfilled results
  mapping(string  → bytes)           reviewComments   // resource: review://{pr_id}/comments
  mapping(string  → bytes)           reviewDiff       // resource: review://{pr_id}/diff

Functions
  requestReview(prId, focus)          → requestId      // emits ReviewRequested
  fulfillReview(requestId, prId,
    summaryJson, commentsJson,
    approved)                                          // oracle only; emits ReviewFulfilled
  getReview(requestId)                → full result
  getComments(prId)                   → bytes          // resource read
  storeDiff(prId, diff)                                // resource write
  getDiff(prId)                       → bytes          // resource read
  cancelReview(requestId)                              // requester only
  addOracle(addr) / removeOracle(addr)                 // owner only

Events
  ReviewRequested(requestId, requester, prId, focus, timestamp)
  ReviewFulfilled(requestId, prId, approved, oracle, timestamp)
  ReviewCancelled(requestId, prId)
  DiffStored(prId, storedBy)
```

### 5.2 `CodeApproverOracle.sol`

Derived from `code-approver.mcp.json`. The three possible MCP decisions (`approved`, `needs_revision`, `rejected`) map to three separate fulfillment functions, giving the contract precise event semantics for each outcome.

```
State
  mapping(bytes32 → ApprovalRequest)  requests
  mapping(bytes32 → ApprovalResult)   results
  mapping(string  → bytes)            approvalDecisions  // resource: approval://{pr_id}/decision

Functions
  requestApproval(prId,
    reviewerAgent, message)           → requestId      // emits ApprovalRequested
  fulfillApproval(requestId, prId,
    reasonJson)                                        // decision = approved
  fulfillNeedsRevision(requestId,
    prId, reasonJson,
    unresolvedJson)                                    // decision = needs_revision
  fulfillRejection(requestId, prId,
    reasonJson)                                        // decision = rejected
  getDecision(prId)                   → bytes          // resource read
  getResult(requestId)                → full result
  cancelApproval(requestId)
  addOracle(addr) / removeOracle(addr)

Events
  ApprovalRequested(requestId, requester, prId, reviewerAgent, timestamp)
  PRApproved(requestId, prId, oracle, timestamp)
  RevisionRequested(requestId, prId, unresolvedBlockers, oracle, timestamp)
  PRRejected(requestId, prId, reason, oracle, timestamp)
  ApprovalCancelled(requestId, prId)
```

---

## 6. MCP Servers

**Location:** `agents_implementation/code-reviewer-server.js`, `agents_implementation/code-approver-server.js`

Each server is a plain Node.js HTTP process. One instance is spawned per agent card. The port is read directly from the card's `endpoint` field.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Returns the agent card |
| `GET` | `/.well-known/agent` | Agent card (A2A/MCP discovery) |
| `POST` | `/mcp` | MCP JSON-RPC 2.0 dispatcher |

### JSON-RPC Methods Handled

| Method | Description |
|---|---|
| `initialize` | MCP handshake — returns server capabilities |
| `tools/list` | Lists all tools with name, description, inputSchema |
| `tools/call` | Invokes a named tool with arguments |
| `resources/list` | Lists available resource URIs |
| `resources/read` | Reads a resource by URI |
| `prompts/list` | Lists available prompts |
| `prompts/get` | Renders a prompt template with supplied arguments |

### Stub Implementation Note

The `review_pr` and `approve_pr` tool handlers currently contain **stub logic** that returns synthetic results. These stubs are clearly marked with `// ── Stub implementation ──` comments and are designed to be replaced with real LLM API calls (e.g. OpenAI, Anthropic, local model) without changing any surrounding infrastructure.

---

## 7. Oracle Bridges

**Location:** `agents_implementation/code-reviewer-bridge.js`, `agents_implementation/code-approver-bridge.js`

A bridge is a lightweight off-chain process that closes the loop between the on-chain oracle contract and the MCP server. It is the only component that speaks both languages.

### Responsibilities

| Responsibility | How |
|---|---|
| Watch for on-chain requests | `ethers.Contract.on(eventName, handler)` — subscribes to provider event stream |
| Route to correct MCP endpoint | Reads agent cards from `../agents`, picks endpoint by capability |
| Call MCP tool | `POST /mcp` with `tools/call` JSON-RPC payload |
| Submit fulfillment transaction | Signs and sends `fulfill*()` call with result bytes |

### Full Request Lifecycle

```
1.  Caller           →  contract.requestReview(prId, focus)
2.  Contract         →  emits ReviewRequested(requestId, ...)
3.  Bridge           ←  receives event via ethers.js listener
4.  Bridge           →  POST http://localhost:8001/mcp  { tools/call: review_pr }
5.  MCP Server       →  returns { summary, comments, approved }
6.  Bridge           →  contract.fulfillReview(requestId, prId, summaryBytes, commentsBytes, approved)
7.  Contract         →  stores result, emits ReviewFulfilled(requestId, approved)
8.  Any caller       →  contract.getComments(prId)  // reads result from chain
```

### Configuration

Bridges accept contract address, RPC URL, and oracle private key via CLI flags or environment variables:

```
REVIEWER_CONTRACT_ADDRESS  /  --reviewer-contract
APPROVER_CONTRACT_ADDRESS  /  --approver-contract
RPC_URL                    /  --rpc
ORACLE_PRIVATE_KEY         /  --privkey
```

---

## 8. Launch Infrastructure

**Location:** `agents_implementation/`

### Starting Agents

```powershell
# PowerShell (recommended — reads ports from agent cards)
.\agents_implementation\launch-agents.ps1

# Node.js
node agents_implementation/launch-agents.js
```

`launch-agents` reads every `*.json` card in `agents/`, extracts the port from `endpoint`, and spawns the correct server script based on capabilities:

```
capability: code-review  →  code-reviewer-server.js
capability: approve-pr   →  code-approver-server.js
```

### Starting Bridges

```powershell
node agents_implementation/launch-bridges.js `
  --reviewer-contract 0x... `
  --approver-contract 0x... `
  --rpc http://127.0.0.1:8545 `
  --privkey 0x...
```

### Stopping Agents

```powershell
.\agents_implementation\stop-agents.ps1
```

PIDs are written to `agent-pids.txt` by `launch-agents.ps1` and consumed by `stop-agents.ps1`.

### Logs

All server and bridge stdout/stderr goes to `agents_implementation/logs/`:

```
logs/alice.log / alice.err.log
logs/bob.log   / bob.err.log
logs/dave.log  / dave.err.log
logs/eve.log   / eve.err.log
logs/code-reviewer-bridge.log / .err.log
logs/code-approver-bridge.log / .err.log
```

---

## 9. Full File Map

```
agents/
  alice.json                          Agent card — CodeReviewerAlice (port 8001)
  bob.json                            Agent card — CodeReviewerBob   (port 8002)
  dave.json                           Agent card — CodeApproverDave  (port 8003)
  eve.json                            Agent card — CodeApproverEve   (port 8004)
  mcp/
    code-reviewer.mcp.json            MCP spec — tools, resources, prompts for reviewers
    code-approver.mcp.json            MCP spec — tools, resources, prompts for approvers

contracts/
  CodeReviewerOracle.sol              On-chain oracle — review request/fulfillment lifecycle
  CodeApproverOracle.sol              On-chain oracle — approval request/fulfillment lifecycle

agents_implementation/
  code-reviewer-server.js             MCP HTTP server for code-reviewer agents
  code-approver-server.js             MCP HTTP server for code-approver agents
  code-reviewer-bridge.js             Oracle bridge — ReviewRequested → review_pr → fulfillReview
  code-approver-bridge.js             Oracle bridge — ApprovalRequested → approve_pr → fulfill*
  launch-agents.js                    Node launcher — spawns one server per card
  launch-agents.ps1                   PowerShell launcher — same, with log redirection
  launch-bridges.js                   Spawns both bridges as background processes
  stop-agents.ps1                     Kills all agents by PID file
```

---

## 10. Design Decisions & Rationale

### Raw `bytes` storage over typed structs
Solidity structs would require a fixed schema baked into the contract. Storing payloads as raw JSON `bytes` keeps contracts schema-agnostic — the MCP spec can evolve (new fields, new comment categories) without requiring a contract upgrade. Off-chain consumers decode JSON however they like.

### Monolithic contracts per agent type
Rather than splitting into `MCPOracle` base + per-tool contracts, the first iteration uses a single self-contained contract per role. This reduces deployment complexity and makes the request/response flow easy to follow. Refactoring to a base class is a natural next step once the interface stabilises.

### Ports taken from agent cards
The MCP server port is the single source of truth — it lives in the agent card's `endpoint` field. Both `launch-agents.js` and `launch-agents.ps1` parse it from there. This avoids port mismatches between the card (which other agents use to call each other) and the actual listening port.

### Bridges are stateless
Each bridge event handler is independently idempotent — it reads the event, calls the MCP tool, and submits the fulfillment. No local database is needed. The oracle contract itself is the source of truth for request state; the `Pending` guard prevents double-fulfillment.

---

## 11. ERC-8004 Extension: Oracle Binding

### Context — the enterprise angle

This system is designed as an **enterprise agentic workflow framework**. In enterprise environments:

- Agent deployments are **strictly controlled** — every agent must be identifiable, auditable, and traceable to a responsible owner
- The set of active agents is **small and known** — scalability of the identity scheme is a secondary concern compared to correctness and auditability
- Compliance and security teams need a **single authoritative source** to answer "what contract does this agent control, who registered it, and when?"
- Agent NFTs may be subject to **transfer controls** — the oracle binding must not persist to a new owner any more than a verified wallet would

This context drove the decision to extend ERC-8004 rather than layer on top of it.

### The problem

The initial oracle contracts used a raw `isOracle[address]` whitelist to authorise `fulfill*()` calls. This creates two independent registries:

```
IdentityRegistry   — knows who the agent is
Oracle whitelist   — knows which address can write results
```

They can drift out of sync. An agent can be revoked from the identity registry but remain in the oracle whitelist. There is no audit trail linking a fulfilled result to a specific registered agent identity.

### Option B — Store oracle address as generic metadata (rejected)

Oracle address stored as an arbitrary metadata entry alongside `capability`, `description`, etc.:

```solidity
register(agentURI, [
    MetadataEntry("capability",    bytes("code-review")),
    MetadataEntry("oracleAddress", abi.encodePacked(oracleAddr))
])
```

**Pros:**
- Zero changes to the ERC-8004 standard
- Already works with existing `setMetadata` / `getMetadata` functions

**Cons:**
- `oracleAddress` is opaque `bytes` — no type safety, no dedicated getter, no dedicated event
- Nothing prevents it being overwritten by any approved operator via `setMetadata`
- Two separate lookups required to resolve an oracle: `getMetadata(agentId, "oracleAddress")` + manual `abi.decode`
- No semantic distinction between oracle binding and arbitrary metadata — auditors see it as just another key
- Oracle binding does **not** clear on transfer without explicit code to handle the `"oracleAddress"` key specially — a latent security gap

### Option A — First-class reserved field (chosen)

`oracleAddress` is promoted to a **reserved typed field** following the exact same pattern as `agentWallet`:

```solidity
bytes32 private constant RESERVED_ORACLE_ADDRESS_KEY_HASH = keccak256("oracleAddress");

function getOracleAddress(uint256 agentId) external view returns (address)
function setOracleAddress(uint256 agentId, address oracleAddress) external   // owner/approved only
event OracleAddressSet(uint256 indexed agentId, address indexed oracleAddress, address indexed setBy)
```

**Why Option A wins for enterprise:**

| Concern | Option B | Option A |
|---|---|---|
| Type safety | `bytes` blob | `address` — compiler-enforced |
| Dedicated event | No | `OracleAddressSet` — queryable audit log |
| Protection from accidental overwrite | No (`setMetadata` accepts any key) | Yes — `_requireNotReserved` blocks it |
| Cleared on transfer | Only if code specifically handles the key | Yes — `_update` clears it unconditionally |
| Single source of truth | No — needs convention + decoding | Yes — `getOracleAddress(agentId)` |
| Audit trail | Buried in generic `MetadataSet` events | Dedicated `OracleAddressSet` events |
| One-shot registration | Not naturally | `register(agentURI, metadata[], oracleAddress)` |

**Storage impact:** zero. `oracleAddress` lives in the existing `_metadata` mapping under the `"oracleAddress"` key. No new storage slots are introduced. The UUPS upgrade path is unaffected.

### The one-shot registration path

The canonical enterprise registration is now a single transaction:

```solidity
uint256 agentId = identityRegistry.register(
    "ipfs://Qm.../alice.json",               // agent card URI
    [MetadataEntry("capability", "code-review")],
    address(codeReviewerOracle)              // oracle binding
);
```

This establishes in one atomic operation:
- Agent identity (ERC-721 token)
- Agent card URI (ERC-721 tokenURI)
- Capability metadata
- Verified `agentWallet` (set to `msg.sender`)
- Oracle contract binding (`oracleAddress`)

All five facts are co-located in a single transaction hash, a single `Registered` event, and a single `OracleAddressSet` event.

### How oracle authorization now works

Oracle contracts no longer maintain their own whitelist. Authorization is fully delegated to the identity registry:

```solidity
modifier onlyRegisteredOracle(uint256 agentId) {
    require(
        identityRegistry.getAgentWallet(agentId) == msg.sender,
        "caller is not the registered agentWallet"
    );
    require(
        identityRegistry.getOracleAddress(agentId) == address(this),
        "agentId not bound to this oracle"
    );
    _;
}
```

Two checks, both resolved from the single identity registry:
1. `msg.sender` is the verified wallet for the agent
2. The agent's registered oracle is this contract

The `agentId` is passed as a parameter by the bridge on every `fulfill*()` call, and is stored in the result — creating a permanent on-chain link from every fulfilled result to the registered agent identity that produced it.

### Transfer behaviour

On ERC-721 transfer, `_update` clears **both** `agentWallet` and `oracleAddress`:

```solidity
if (from != address(0) && to != address(0)) {
    $._metadata[tokenId]["agentWallet"]   = "";
    $._metadata[tokenId]["oracleAddress"] = "";
    emit OracleAddressSet(tokenId, address(0), msg.sender);
}
```

The new owner must re-bind their own wallet and oracle. This prevents a transferred agent identity from inheriting access to the previous owner's oracle contracts — a critical enterprise security property.

---

## 12. Status & Remaining Work

### Completed since initial proposal

| Item | Notes |
|---|---|
| `deploy-registries.js` deploying oracles with identity registry address | Done; `register-mocks.js` also wires cards and oracle addresses in one script |
| Bridges pass `agentId` on every `fulfill*()` call | Done; agentId is stored in every result struct |
| 10-layer governance stack | Flow authorization, reputation gating, prompt governance, dataset control, autonomy bounding, flow anomaly detection, card integrity, action-level authorization — all implemented; see [concepts.md](./concepts.md) |
| MCP spec extensions (`autonomy_bounds`, `action_permits`) | Documented in [mcp.extension.md](./mcp.extension.md) |
| ERC-8004 identity registry — `cardHash` third reserved key | Documented in [8004.refactor.md](./8004.refactor.md) |

### Remaining

| Priority | Item |
|---|---|
| High | Python bounds monitor — port `bounds-monitor.js` logic (sliding-window error/success rates, burst detection, timeout detection) to Python to restore full Layer 6/7 dynamic revocation. Node.js runtime archived at git tag `node-js-runtime-archive`. |
| Medium | Add a `deployed-addresses.json` output from deploy scripts so bridges read contract addresses without CLI flags |
| Medium | Extract `MCPOracle.sol` base contract — `onlyRegisteredOracle` modifier, `requestId` generation, shared 10-layer auth stack — to avoid duplication between `CodeReviewerOracle` and `CodeApproverOracle` |
| Medium | Replace raw `bytes` payload storage in oracle contracts with `payloadHash` only (prerequisite for cross-bank deployment; see [b2b.agentic.flow.md](./b2b.agentic.flow.md)) |
| Low | `resources/subscribe` support in MCP servers for real-time resource push |
| Low | Replace in-memory `reviewStore` / `decisionStore` in MCP servers with persistent storage or direct on-chain reads |
| Low | Round-robin / load-balancing across multiple reviewer instances (Alice + Bob) in the bridge |

### Cross-institutional / consortium deployment

For analysis of extending this architecture to a permissioned inter-institutional blockchain, see [b2b.agentic.flow.md](./b2b.agentic.flow.md).

For the reference implementation of this architecture — an institutional client onboarding flow (bank ↔ hedge fund) with 10 agents across both institutions, parallel AML / Credit / Legal sub-workflows, iterative negotiation, human-in-the-loop approvals, and sequential setup phases — see [onboarding.flow.md](./onboarding.flow.md).

---

## 13. Off-Chain Runtime

The off-chain layer is implemented in Python (`agents_implementation_py/`) using web3.py AsyncWeb3, LangChain LCEL chains (`ChatPromptTemplate | ChatOpenAI.with_structured_output`), and a LangGraph `StateGraph` for the onboarding orchestrator. The Node.js reference implementation has been archived (git tag: `node-js-runtime-archive`).

The Python layer consumes the same on-chain contracts, agent cards (`agents/*.json`), and MCP specs (`agents/mcp/*.mcp.json`). MCP specs carry a `langchain_messages` field (alongside the original `template` field) used by Python servers to build `ChatPromptTemplate` instances. Prompt hash v1 is registered in `scripts/deploy.js` but not yet activated.

> **Bounds monitor gap:** `bounds-monitor.js` (archived with the Node.js runtime) has no Python replacement yet. Python bridges and servers degrade gracefully — if `bounds-state.json` is absent, all tools are assumed enabled. A Python bounds monitor is the primary remaining work item for full Layer 6/7 parity.

