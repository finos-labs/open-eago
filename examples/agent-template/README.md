# OpenEAGO RPC Agent Template

A template and reference design for building **MCP (Model Context Protocol) RPC agents** that are aligned with the [OpenEAGO](../../SPECIFICATION.md) specification. The design extends the MCP surface with additional enterprise metadata, phase alignment, and configuration-driven behaviour.

> **Reference / template only.** Use this to bootstrap an agent that speaks MCP JSON-RPC while advertising OpenEAGO phases, envelope semantics, and optional registry integration.

---

## Description

### What this is

- **RPC agent**: Exposes tools (and optionally resources/prompts) over the [Model Context Protocol](https://modelcontextprotocol.io/) — JSON-RPC 2.0 over stdio, SSE, or Streamable HTTP.
- **OpenEAGO-aligned**: Metadata and configuration follow the OpenEAGO spec: six phases, base envelope (`message_id`, `phase`, `timestamp`, `payload`, `metadata`), and optional risk context propagation.
- **Configuration-first**: Agent identity, capabilities, and EAGO options are defined in YAML config and/or MCP spec JSON so the same binary can serve different roles (e.g. contract vs execution phase agent).

### What it is not

- Not a full implementation: this example provides **config layout**, **MCP spec shape**, and **documentation**. Implement the actual MCP server (e.g. with an MCP SDK) in the language of your choice.

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
- **Runtime**: Implement an MCP server that reads this config and spec, and optionally wraps requests/responses in the OpenEAGO base envelope when `eago_envelope: true`.

---

## Configuration

Configuration is YAML. Example: [config.example.yaml](./config.example.yaml). Copy to `config.yaml` and adjust.

### Top-level sections

| Section      | Purpose |
|-------------|---------|
| `server`    | Host, port, transport (`stdio` \| `sse` \| `streamable-http`). |
| `metadata`  | OpenEAGO-aligned: `name`, `version`, `description`, `spec_version`, `eago_phases`, `capabilities`, `tags`. Must match [spec/v0.1.0/spec.json](../../spec/v0.1.0/spec.json) phase enum and metadata style. |
| `agent`     | Agent registry payload: `instance_id`, `capability_codes`, `version`, `jurisdiction`, `compliance`, `reliability`, `endpoints`, etc. Same shape as [agent-registry](../../examples/agent-registry) `agent_details`. |
| `mcp`       | MCP protocol version, schema URL, and OpenEAGO extensions: `eago_envelope`, `phase_header`, `risk_context_header`. |
| `spire`     | Optional mTLS: `enabled`, `cert_path`, `key_path`, `bundle_path` (e.g. for registry or EAGO transport). |
| `bootstrap` | Optional registry bootstrap URLs and `sync_interval` for self-registration. |

### Metadata and protocol alignment

- **Phases**: `metadata.eago_phases` MUST use the canonical list from the spec:
  - `contract_management`, `planning_negotiation`, `validation_compliance`, `execution_resilience`, `context_state_management`, `communication_delivery`
- **Envelope**: When `mcp.eago_envelope` is true, the implementation SHOULD wrap MCP request/response payloads in the [base envelope](https://finos-labs.github.io/open-eago/spec/v0.1.0/schemas/base-envelope.schema.json): `message_id`, `phase`, `timestamp`, `payload`, optional `metadata` and `correlation_id`.
- **Risk context**: If the orchestrator sends risk context (e.g. in a header or in the envelope `metadata`), the agent SHOULD propagate it (e.g. via `mcp.risk_context_header`) as per SPECIFICATION.md § E.5.

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
| **Envelope**      | None                  | Optional EAGO base envelope around payloads (`message_id`, `phase`, `timestamp`, `payload`, `metadata`). |
| **Phase**         | N/A                   | Explicit `eago_phases` in config and MCP spec; optional `X-EAGO-Phase` (or equivalent) for request context. |
| **Risk / audit**  | N/A                   | Optional propagation of `risk_context` (header or envelope metadata). |
| **Registry**      | N/A                   | Optional: register with [OpenEAGO Agent Registry](../../examples/agent-registry) using `agent` config and bootstrap URLs. |

So: **protocol remains MCP**; **configuration and optional wrapping** add OpenEAGO metadata, phase alignment, envelope, and registry integration.

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

4. **EAGO envelope (optional)**
   - When `mcp.eago_envelope` is true, the server can wrap MCP payloads in the [base envelope](https://finos-labs.github.io/open-eago/spec/v0.1.0/schemas/base-envelope.schema.json).
   - Aligns message shape with OpenEAGO Phase 5/6 and audit expectations.

5. **Phase and risk context**
   - Optional headers (e.g. `X-EAGO-Phase`, `X-EAGO-Risk-Context`) for request/response context.
   - Supports SPECIFICATION.md risk context propagation (Appendix E.5) without changing MCP method names or parameters.

6. **SPIRE / bootstrap**
   - Optional `spire` and `bootstrap` config for mTLS and registry sync, consistent with the [agent-registry](../../examples/agent-registry) example.

These extensions stay **additive**: a standard MCP client can still use the agent; an OpenEAGO orchestrator can use config + envelope + headers for phase-aware, auditable flows.

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
   - Optionally wraps messages in the EAGO base envelope when `mcp.eago_envelope` is true.
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
