# agents_implementation

Off-chain MCP server infrastructure and oracle bridges. One Node.js MCP server process per agent card, plus one bridge process per oracle contract.

## Directory layout

```
agents_implementation/
  code-reviewer-server.js   ← MCP server for code-review agents (Alice, Bob)
  code-approver-server.js   ← MCP server for code-approver agents (Dave, Eve)
  code-reviewer-bridge.js   ← Oracle bridge: ReviewRequested → review_pr → fulfillReview
  code-approver-bridge.js   ← Oracle bridge: ApprovalRequested → approve_pr → fulfill*
  launch-agents.js          ← Node.js launcher (spawns all agent servers, foreground)
  launch-agents.ps1         ← PowerShell launcher (background processes, logs to logs/)
  launch-bridges.js         ← Spawns both oracle bridges as background processes
  stop-agents.ps1           ← Kills all background agents started by launch-agents.ps1
  logs/                     ← Auto-created; one .log/.err.log per agent and bridge
  package.json
```

Agent cards live in `../agents/*.json`.

---

## How ports are assigned

Ports are read directly from each agent card's `endpoint` field — the launcher does not assign them:

| Card       | Endpoint                   | Server spawned            |
|------------|----------------------------|---------------------------|
| alice.json | http://localhost:**8001**  | code-reviewer-server.js   |
| bob.json   | http://localhost:**8002**  | code-reviewer-server.js   |
| dave.json  | http://localhost:**8003**  | code-approver-server.js   |
| eve.json   | http://localhost:**8004**  | code-approver-server.js   |

The server script is chosen based on the card's `capabilities` field:

| Capability    | Server script              |
|---------------|----------------------------|
| `code-review` | `code-reviewer-server.js`  |
| `approve-pr`  | `code-approver-server.js`  |

---

## Running MCP servers

### Foreground (Node.js — all output in one terminal)

```powershell
cd agents_implementation
node launch-agents.js
```

Press **Ctrl-C** to stop everything.

### Background (PowerShell — each agent logs to `logs/`)

```powershell
cd agents_implementation
.\launch-agents.ps1
```

Stop all agents:

```powershell
.\stop-agents.ps1
```

---

## Running oracle bridges

Bridges watch for on-chain events and call back the oracle contracts with MCP tool results.
They require deployed contract addresses and an oracle private key.

### Via CLI flags

```powershell
node launch-bridges.js `
  --reviewer-contract  0x<CodeReviewerOracle> `
  --approver-contract  0x<CodeApproverOracle> `
  --rpc                http://127.0.0.1:8545 `
  --privkey            0x<OraclePrivateKey> `
  --flow-auth          0x<FlowAuthorizationRegistry> `  # optional
  --reputation-gate    0x<ReputationGate> `             # optional
  --prompt-registry    0x<PromptRegistry> `             # optional
  --reviewer-agent-id  0 `                              # optional, default 0
  --approver-agent-id  1                                # optional, default 0
```

### Via environment variables

```powershell
$env:REVIEWER_CONTRACT_ADDRESS = "0x..."
$env:APPROVER_CONTRACT_ADDRESS = "0x..."
$env:RPC_URL                   = "http://127.0.0.1:8545"
$env:ORACLE_PRIVATE_KEY        = "0x..."
$env:FLOW_AUTH_ADDRESS         = "0x..."   # optional
$env:REPUTATION_GATE_ADDRESS   = "0x..."   # optional
$env:PROMPT_REGISTRY_ADDRESS   = "0x..."   # optional
$env:REVIEWER_AGENT_ID         = "0"       # optional
$env:APPROVER_AGENT_ID         = "1"       # optional
node launch-bridges.js
```

Bridge logs are written to `logs/code-reviewer-bridge.log` and `logs/code-approver-bridge.log`.

### Bridge flags reference

| Flag | Env var | Description |
|------|---------|-------------|
| `--reviewer-contract` | `REVIEWER_CONTRACT_ADDRESS` | CodeReviewerOracle address (required) |
| `--approver-contract` | `APPROVER_CONTRACT_ADDRESS` | CodeApproverOracle address (required) |
| `--rpc` | `RPC_URL` | JSON-RPC endpoint (default: `http://127.0.0.1:8545`) |
| `--privkey` | `ORACLE_PRIVATE_KEY` | Oracle wallet private key (required) |
| `--flow-auth` | `FLOW_AUTH_ADDRESS` | FlowAuthorizationRegistry address (optional) |
| `--reputation-gate` | `REPUTATION_GATE_ADDRESS` | ReputationGate address (optional) |
| `--prompt-registry` | `PROMPT_REGISTRY_ADDRESS` | PromptRegistry address (optional) |
| `--reviewer-agent-id` | `REVIEWER_AGENT_ID` | ERC-8004 agentId for reviewer bridge (default: `0`) |
| `--approver-agent-id` | `APPROVER_AGENT_ID` | ERC-8004 agentId for approver bridge (default: `0`) |

---

## Flow-scoped authorization

When `--flow-auth` is provided, bridges perform an **off-chain pre-flight check** before submitting any fulfillment transaction:

```
bridge receives event → checks isAuthorized(traceId, agentId, capability) → if false, skips tx
```

This is **defense-in-depth**: the on-chain oracle contract performs the same check via `FlowAuthorizationRegistry.isAuthorized()`. The bridge-level check saves gas by avoiding a transaction that would revert on-chain.

If no flow policy is registered for the `traceId` (i.e. the flow was not created via `createFlow()`), `isAuthorized()` returns `true` and the bridge proceeds normally. This makes flow-scoped authorization **opt-in per flow** — existing flows without a registered policy are unaffected.

To create a flow policy before execution begins, call `FlowAuthorizationRegistry.createFlow(traceId, authorizations[])` on-chain from your orchestrator.

---

## Reputation-gated actions

When `--reputation-gate` is provided, bridges perform an **off-chain pre-flight check** before submitting any fulfillment transaction:

```
bridge receives event → checks meetsThreshold(agentId, capability) → if false, skips tx
```

This is **defense-in-depth**: the on-chain oracle contract performs the same check via `ReputationGate.meetsThreshold()`. The bridge-level check saves gas by avoiding a transaction that would revert on-chain.

The reputation gate enforces a quality bar on top of the identity and flow authorization checks:

```
onlyRegisteredOracle(agentId)          ← identity check
  → flowAuth.isAuthorized(...)         ← flow participation check
    → reputationGate.meetsThreshold()  ← quality bar
      → state change
```

If no threshold is configured for a capability (or no evaluators are registered), `meetsThreshold()` returns `true` and the bridge proceeds normally. This makes reputation gating **opt-in per capability** — existing flows without thresholds configured are unaffected.

Thresholds are per-capability and filter by a trusted evaluator list. Only feedback from addresses in `ReputationGate.getEvaluators()` counts toward an agent's score for a given capability.

---

## Prompt governance

When `--prompt-registry` is provided, bridges enforce prompt template integrity as the fifth authorization layer:

```
bridge starts up → reads agents/mcp/*.mcp.json → computes keccak256(template) → stores as PROMPT_HASH
bridge receives event → checks isActive(capability, PROMPT_HASH) → if false, skips tx
bridge submits tx → includes PROMPT_HASH in fulfillment params struct
oracle contract → checks isActive(capability, promptHash) on-chain → reverts "unrecognized prompt" if not active
```

This is **defense-in-depth**: the on-chain oracle contract performs the same check via `PromptRegistry.isActive()`. The bridge-level pre-flight saves gas by avoiding a transaction that would revert on-chain.

The full authorization stack after all five layers:

```
onlyRegisteredOracle(agentId)              ← identity check
  → flowAuth.isAuthorized(...)             ← flow participation check
    → reputationGate.meetsThreshold()      ← quality bar
      → promptRegistry.isActive(...)       ← prompt integrity check
        → state change
```

If no active version is configured for a capability, `isActive()` returns `true` — opt-in, backward-compatible. `PROMPT_HASH` is computed once at startup from the raw template string in the MCP spec file; it is stable as long as the template is unchanged.

To rotate a prompt: call `PromptRegistry.registerPrompt(capability, newHash, metadataUri)` then `setActiveVersion(capability, newIndex)`. All bridge processes using the old template hash will fail pre-flight until their MCP spec files are updated and they are restarted.

---

## HTTP API

Every agent server exposes:

| Method | Path                 | Description                          |
|--------|----------------------|--------------------------------------|
| GET    | `/`                  | Returns the agent card JSON          |
| GET    | `/.well-known/agent` | Same — MCP / A2A discovery URL       |
| POST   | `/mcp`               | MCP JSON-RPC 2.0 endpoint            |

### JSON-RPC methods

| Method             | Description                                          |
|--------------------|------------------------------------------------------|
| `initialize`       | MCP handshake — returns server capabilities          |
| `tools/list`       | Lists tools with name, description, inputSchema      |
| `tools/call`       | Invokes a named tool with arguments                  |
| `resources/list`   | Lists available resource URIs                        |
| `resources/read`   | Reads a resource by URI                              |
| `prompts/list`     | Lists available prompts                              |
| `prompts/get`      | Renders a prompt template with supplied arguments    |

### Tools — code-reviewer (Alice, Bob)

| Tool                | Description                                               |
|---------------------|-----------------------------------------------------------|
| `review_pr`         | Reviews a PR — returns `{ summary, comments[], approved }` |
| `get_review_status` | Returns current review status and comments for a PR       |
| `store_diff`        | Stores a raw unified diff as a resource                   |
| `agent/info`        | Returns the full agent card                               |
| `agent/ping`        | Health check → `{ status: "pong" }`                       |

### Tools — code-approver (Dave, Eve)

| Tool         | Description                                                     |
|--------------|-----------------------------------------------------------------|
| `approve_pr` | Issues an approval decision after reading reviewer comments     |
| `reject_pr`  | Rejects a PR with a reason                                      |
| `agent/info` | Returns the full agent card                                     |
| `agent/ping` | Health check → `{ status: "pong" }`                             |

### Resources

| URI pattern                    | Agent type    | Content                         |
|--------------------------------|---------------|---------------------------------|
| `review://{pr_id}/comments`    | code-reviewer | Latest review comments (JSON)   |
| `review://{pr_id}/diff`        | code-reviewer | Raw PR diff (text)              |
| `approval://{pr_id}/decision`  | code-approver | Latest approval decision (JSON) |

### Prompts

| Prompt               | Agent type    | Arguments                              |
|----------------------|---------------|----------------------------------------|
| `code_review`        | code-reviewer | `pr_id`, `language?`, `focus?`         |
| `approve_pr_prompt`  | code-approver | `pr_id`, `reviewer_summary?`           |

### Example requests

```bash
# Agent card
curl http://localhost:8001/

# List tools
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Request a code review
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"review_pr","arguments":{"pr_id":"42"}}}'

# Read review comments resource
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"review://42/comments"}}'

# Get the code review prompt
curl -X POST http://localhost:8001/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":4,"method":"prompts/get","params":{"name":"code_review","arguments":{"pr_id":"42","language":"Solidity"}}}'
```

---

## Adding / editing agents

1. Create or edit a file in `../agents/`. Set a unique port in `endpoint` and set `capabilities` to `["code-review"]` or `["approve-pr"]`.
2. Set `mcpSpec` to point to the appropriate MCP spec in `../agents/mcp/`.
3. Restart the launcher — new cards are picked up automatically.

## Adding tools to a server

Open the relevant server file (`code-reviewer-server.js` or `code-approver-server.js`) and add an entry to the `TOOLS` object:

```js
my_tool: {
  description: 'Does something useful.',
  inputSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input']
  },
  handler: (params) => {
    return { result: params.input.toUpperCase() };
  }
}
```
