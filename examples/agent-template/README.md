# OpenEAGO RPC Agent Template

A template and reference design for building **MCP (Model Context Protocol) RPC agents** that are aligned with the [OpenEAGO](../../SPECIFICATION.md) specification. The design extends the MCP surface with additional enterprise metadata, phase alignment, and configuration-driven behaviour.

> **Reference / template only.** Use this to bootstrap an agent that speaks MCP JSON-RPC while advertising OpenEAGO phases, envelope semantics, and optional registry integration.

---

## Description

### What this is

- **Working Python demo agent**: Includes a runnable HTTP(S) MCP JSON-RPC server (`/mcp`) with tools/resources/prompts support, plus OpenEMCP-style endpoints (`/api/execute`, `/health`, `/metrics`).
- **OpenEAGO-aligned metadata**: Configuration and MCP spec include OpenEAGO phase metadata, capability declarations, and registry-compatible agent details.
- **Configuration-first**: Agent identity, capabilities, and runtime options are defined in YAML config and MCP spec JSON so the same code can serve different roles.

### What it is not

- Not production-complete: this demo is intentionally minimal and currently focuses on HTTP(S) JSON-RPC + registry integration. Some documented OpenEAGO behaviors are roadmap items (see **Planned extensions**).

### Implemented now

- MCP JSON-RPC endpoints: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`.
- Built-in tools: `agent/info`, `agent/ping`, plus custom tools from `agent.mcp.json` (for example `eago_health`).
- OpenEMCP-style HTTP endpoints: `POST /api/execute`, `GET /health`, `GET /metrics`.
- SPIRE mTLS support for agent serving and registry calls (with `--allow-insecure` development mode).
- Config validation for phase enum and reliability/uptime bounds.
- Registration/status/deregistration loops against OpenEAGO Agent Registry when `bootstrap.urls` is configured.

### Planned extensions

- EAGO base-envelope wrapping of MCP payloads controlled by `mcp.eago_envelope`.
- Explicit phase/risk context propagation via headers such as `X-EAGO-Phase` and `X-EAGO-Risk-Context`.
- Additional transports beyond HTTP(S) runtime (for example stdio/SSE).
- Expanded OpenEAGO conformance checks and richer enterprise policy hooks.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                    RPC Agent (this template)                │
│  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────┐ │
│  │ config.yaml │  │ agent.mcp.json   │  │ EAGO base envelope  │ │
│  │ metadata    │  │ tools/resources  │  │ phase, risk_context │ │
│  │ agent       │  │ open_eago block  │  │ (optional wrap)     │ │
│  │ mcp / spire │  │                  │  │                     │ │
│  └─────────────┘  └──────────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
         │                     │                       │
         ▼                     ▼                       ▼
   OpenEAGO spec          MCP 1.0 JSON-RPC        spec/schemas
   (phases, envelope)    (tools/list, call)      (base-envelope)
```

- **Config**: Drives server bindings, transport, metadata, agent registration fields, and EAGO options.
- **MCP spec**: Declares tools (and optionally resources/prompts) and an `open_eago` extension block for phase list and envelope semantics.
- **Runtime (current)**: Python HTTP(S) server that loads config + MCP spec and serves JSON-RPC methods plus OpenEMCP-style health/metrics/execute endpoints.
- **Runtime (planned)**: Optional OpenEAGO base-envelope wrapping when `eago_envelope: true`.

---

## Configuration

Configuration is YAML. Example: [config.example.yaml](./config.example.yaml). Copy to `config.yaml` and adjust.

### Top-level sections

| Section      | Purpose |
|-------------|---------|
| `server`    | Host, port, and transport metadata (runtime currently serves HTTP(S) endpoint `/mcp`). |
| `metadata`  | OpenEAGO-aligned: `name`, `version`, `description`, `spec_version`, `eago_phases`, `capabilities`, `tags`. Must match [spec/v0.1.0/spec.json](../../spec/v0.1.0/spec.json) phase enum and metadata style. |
| `agent`     | Agent registry payload: `instance_id`, `capability_codes`, `version`, `jurisdiction`, `compliance`, `reliability`, `endpoints`, etc. Same shape as [agent-registry](../../examples/agent-registry) `agent_details`. |
| `mcp`       | MCP protocol version and OpenEAGO extension flags (currently used for metadata/compatibility; envelope/header behavior is planned). |
| `spire`     | Optional mTLS: `enabled`, `cert_path`, `key_path`, `bundle_path` (e.g. for registry or EAGO transport). |
| `bootstrap` | Optional registry bootstrap URLs and `sync_interval` for self-registration. |

### Metadata and protocol alignment

- **Phases**: `metadata.eago_phases` MUST use the canonical list from the spec:
  - `contract_management`, `planning_negotiation`, `validation_compliance`, `execution_resilience`, `context_state_management`, `communication_delivery`
- **Envelope (planned)**: `mcp.eago_envelope` is available in config and intended to control wrapping MCP payloads in the [base envelope](https://finos-labs.github.io/open-eago/spec/v0.1.0/schemas/base-envelope.schema.json).
- **Risk context (planned)**: Header-based/context propagation (`risk_context_header`) is planned for fuller SPECIFICATION.md Appendix E.5 alignment.

---

## Comparison with MCP

### Standard MCP (baseline)

- **Transport**: JSON-RPC 2.0 over stdio, SSE, or Streamable HTTP.
- **Methods**: `initialize`, `tools/list`, `tools/call`, `resources/*`, `prompts/*`.
- **Schema**: Server and tool definitions follow the [MCP server schema](https://modelcontextprotocol.io/schema/v1/server.json); tools have `name`, `description`, `inputSchema`.
- **No built-in**: Phase semantics, enterprise envelope, risk context, or registry integration.

### This template (OpenEAGO RPC agent)

| Aspect            | MCP only              | This template (OpenEAGO + MCP) |
|------------------|------------------------|---------------------------------|
| **Protocol**      | JSON-RPC 2.0          | Same; no change to wire format. |
| **Tools**         | `name`, `description`, `inputSchema` | Same; plus optional `open_eago` / tool-level extensions in spec. |
| **Metadata**      | Server `name`/`version` in init      | Full metadata in **config**: phases, capabilities, tags, spec_version. |
| **Envelope**      | None                  | Planned: optional EAGO base envelope around payloads (`message_id`, `phase`, `timestamp`, `payload`, `metadata`). |
| **Phase**         | N/A                   | Implemented metadata (`eago_phases`); planned request-context headers. |
| **Risk / audit**  | N/A                   | Planned propagation of `risk_context` (header or envelope metadata). |
| **Registry**      | N/A                   | Optional: register with [OpenEAGO Agent Registry](../../examples/agent-registry) using `agent` config and bootstrap URLs. |

So: **protocol remains MCP**; current implementation already adds OpenEAGO metadata and optional registry integration, with envelope/header propagation planned.

---

## What Was Extended

Relative to plain MCP, the following are **added or extended** in this template (and in the openemcp-clm–style design):

1. **Configuration metadata**
   - `metadata` block: `spec_version`, `eago_phases`, `capabilities`, `tags` aligned with [spec/v0.1.0/spec.json](../../spec/v0.1.0/spec.json).
   - Ensures agents can advertise which OpenEAGO phases they support and which capabilities they provide.

2. **Agent registration payload**
   - `agent` section mirrors the [agent-registry](../../examples/agent-registry) `AgentDetails`: `instance_id`, `capability_codes`, `jurisdiction`, `compliance`, `reliability`, `endpoints`, etc.
   - Enables one config to drive both the MCP server and registry registration (when implemented).

3. **MCP spec extension: `open_eago`**
   - In `agent.mcp.json`, an `open_eago` block documents:
     - `spec_version`
     - `eago_phases`
     - `base_envelope` (required/optional fields).
   - Standard MCP clients ignore unknown keys; EAGO-aware tooling can use this for discovery and validation.

4. **EAGO envelope (planned)**
  - `mcp.eago_envelope` is available and reserved for wrapping MCP payloads in the [base envelope](https://finos-labs.github.io/open-eago/spec/v0.1.0/schemas/base-envelope.schema.json).
  - This behavior is planned and not yet enforced by the current demo runtime.

5. **Phase and risk context (planned)**
  - Optional headers (e.g. `X-EAGO-Phase`, `X-EAGO-Risk-Context`) for request/response context.
  - Intended to support SPECIFICATION.md risk context propagation (Appendix E.5) without changing MCP method names or parameters.

6. **SPIRE / bootstrap**
   - Optional `spire` and `bootstrap` config for mTLS and registry sync, consistent with the [agent-registry](../../examples/agent-registry) example.

These extensions stay **additive**: a standard MCP client can use the agent today, while OpenEAGO-aware orchestrators can already consume metadata and registry integration, with envelope/header features planned.

---

## Files in this example

| File                   | Purpose |
|------------------------|--------|
| [config.example.yaml](./config.example.yaml) | Example configuration: server, metadata, agent, mcp, spire, bootstrap. |
| [config.yaml](./config.yaml)                 | Demo config with SPIRE mTLS and `bootstrap.urls` for registry. |
| [agent.mcp.json](./agent.mcp.json)           | MCP server spec with one tool (`eago_health`) and `open_eago` extension. |
| [demo_agent.py](./demo_agent.py)             | **Demo RPC agent (Python)**: HTTPS with SPIRE mTLS, tools/list + tools/call, registry registration over mTLS. |
| [requirements.txt](./requirements.txt)        | Python deps (PyYAML). |
| [README.md](./README.md)                     | This file: description, configuration, MCP comparison, extensions, demo. |

---

## Demo: run the RPC agent (Python + SPIRE mTLS)

The **demo agent** ([demo_agent.py](./demo_agent.py)) uses the template with **SPIRE mTLS**: the server presents an SVID and requires client certificates, and registry registration uses mTLS. Same behaviour over plain HTTP is available with `--allow-insecure` for local dev only.

### OpenEMCP-compatible HTTP endpoints

This demo also implements the **OpenEMCP CLM base agent** endpoints from `openemcp-clm/common/base_agent.py`:

- `POST /api/execute` — execute on a JSON state payload (demo implementation echoes payload + adds `_agent` and `_handled_at`)
- `GET /health` — health status + uptime/reliability
- `GET /metrics` — request/error counters + uptime/reliability

### Prerequisites

- Python ≥ 3.9
- [SPIRE](https://spiffe.io/docs/latest/spire-about/) (for mTLS): server and agent running, SVID fetched to e.g. `/tmp/svid.0.pem`, `/tmp/svid.0.key`, `/tmp/bundle.0.pem` — or set `SPIRE_CERT_PATH`, `SPIRE_KEY_PATH`, `SPIRE_BUNDLE_PATH`
- (Optional) [OpenEAGO Agent Registry](../../examples/agent-registry) for registration (run with mTLS; use `https://` in `bootstrap.urls`)

### 1. Install and start the demo agent (mTLS)

```bash
cd examples/agent-template
python3 -m venv .venv
source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
python demo_agent.py
```

With SPIRE certs in place you should see:

```text
[demo-agent] OpenEAGO RPC agent → https://127.0.0.1:9000 (SPIRE mTLS: True)
[demo-agent] GET / or GET /.well-known/agent → agent card
[demo-agent] POST /mcp → MCP JSON-RPC (tools/list, tools/call)
[demo-agent] Registered with https://127.0.0.1:8443/register
[demo-agent] Registry sync every 30s
```

Options:

```bash
python demo_agent.py --port=9000
python demo_agent.py --no-register
python demo_agent.py --config=config.yaml
python demo_agent.py --allow-insecure   # HTTP only, no mTLS (dev only)
```

### 2. Start the registry (mTLS) for registration

Run the registry in **bootstrap** mode **with** mTLS (no `--allow-insecure`), using the same SPIRE trust domain and SVIDs. See [Agent Registry README](../../examples/agent-registry/README.md) for SPIRE setup. Then set `bootstrap.urls` in [config.yaml](./config.yaml) to `["https://127.0.0.1:8443"]` and start the demo agent; it will register over mTLS.

For **local dev without SPIRE**, you can run the registry with `--allow-insecure` and the agent with `--allow-insecure`, and use `http://127.0.0.1:8443` in `bootstrap.urls`.

### 3. Call the RPC (with mTLS)

Use the same SPIRE-issued client cert (e.g. from the registry’s Swagger proxy or another workload’s SVID) to call the agent:

**Agent card (GET):**

```bash
curl -s https://127.0.0.1:9000/ \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k | jq
```

**List tools (MCP JSON-RPC):**

```bash
curl -s -X POST https://127.0.0.1:9000/mcp \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | jq
```

**Call `eago_health` tool:**

```bash
curl -s -X POST https://127.0.0.1:9000/mcp \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"eago_health","arguments":{}}}' | jq
```

(`-k` disables hostname verification; SPIFFE SVIDs use URI SANs. CA verification is still done via `--cacert`.)

If you ran the agent with `--allow-insecure`, use `http://127.0.0.1:9000` and omit the cert options.

**Built-in tools:**

- `agent/info` — returns the agent card JSON
- `agent/ping` — returns `{ "status": "pong", "agent": "...", "port": 9000 }`

### Call OpenEMCP endpoints (with mTLS)

Execute:

```bash
curl -s -X POST https://127.0.0.1:9000/api/execute \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k \
  -H "Content-Type: application/json" \
  -d '{"state":"example","counter":1}' | jq
```

Health and metrics:

```bash
curl -s https://127.0.0.1:9000/health \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k | jq

curl -s https://127.0.0.1:9000/metrics \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k | jq
```

### 4. Verify registration (if registry is running)

With mTLS:

```bash
curl -s https://127.0.0.1:8443/list \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem -k | jq
```

You should see the demo agent (e.g. `127.0.0.1:9000`) with its `agent_details` from config.

---

## How to use this template

1. Copy [config.example.yaml](./config.example.yaml) to `config.yaml` and set `metadata`, `agent`, and `server` for your environment.
2. Run the **demo agent** for a working reference, or implement your own MCP server that:
   - Loads `config.yaml` and `agent.mcp.json`.
   - Serves `tools/list` and `tools/call` (and optionally resources/prompts) per the spec.
  - Optionally (planned) wraps messages in the EAGO base envelope when `mcp.eago_envelope` is enabled.
   - Optionally registers with the OpenEAGO Agent Registry using the `agent` section and `bootstrap.urls`.
3. For strict conformance, ensure `metadata.eago_phases` and any phase-specific behaviour match [SPECIFICATION.md](../../SPECIFICATION.md) and the [schema catalog](../../spec/v0.1.0/spec.json).

---

## References

- [OpenEAGO SPECIFICATION.md](../../SPECIFICATION.md)
- [OpenEAGO spec.json](../../spec/v0.1.0/spec.json) — metadata, phases, schema catalog
- [Base envelope schema](../../spec/v0.1.0/schemas/base-envelope.schema.json)
- [OpenEAGO Agent Registry](../../examples/agent-registry/README.md)
- [Model Context Protocol](https://modelcontextprotocol.io/)

---

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
