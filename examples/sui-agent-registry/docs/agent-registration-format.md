# Agent Registration File Format

Agents registered in the SUI Agentic Registry should publish a JSON file at the URL stored in their `agentUri` field (typically `https://example.com/.well-known/agent.json`).

The format extends the [Google A2A AgentCard](https://google.github.io/A2A/) specification with three additional top-level fields: `services`, `registrations`, and `supportedTrust`.

---

## Full example

```json
{
  "agentId": "sui:testnet:0xabc123...:42",
  "name": "DataAnalystAgent",
  "version": "1.2.0",
  "description": "A data analysis agent specialized in time-series and tabular data.",
  "url": "https://agent.example.com",
  "documentationUrl": "https://agent.example.com/docs",
  "provider": {
    "organization": "Acme AI Labs",
    "url": "https://acme.ai"
  },
  "iconUrl": "https://agent.example.com/icon.png",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": true
  },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    {
      "id": "time-series-analysis",
      "name": "Time Series Analysis",
      "description": "Forecasting, anomaly detection and trend analysis on time-series data.",
      "tags": ["data", "forecasting", "anomaly-detection"],
      "inputModes": ["application/json"],
      "outputModes": ["application/json", "image/png"]
    },
    {
      "id": "csv-query",
      "name": "CSV / Tabular Query",
      "description": "Natural-language queries over uploaded CSV files.",
      "tags": ["data", "sql", "csv"]
    }
  ],
  "active": true,

  "services": [
    {
      "name": "analysis-api",
      "endpoint": "https://agent.example.com/a2a",
      "version": "1.2.0",
      "skills": ["time-series-analysis", "csv-query"],
      "domains": ["data-analytics", "forecasting"]
    }
  ],

  "registrations": [
    {
      "agentId": "sui:testnet:0xabc123...:42",
      "agentRegistry": "sui:testnet:0xabc123..."
    }
  ],

  "supportedTrust": ["sui:testnet:0xabc123...:42"]
}
```

---

## Field reference

### Standard A2A AgentCard fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Human-readable agent name |
| `version` | string | yes | Semantic version |
| `description` | string | no | Short description |
| `url` | string | yes | Base URL of the agent service |
| `documentationUrl` | string | no | Docs URL |
| `provider` | object | no | `{ organization, url }` |
| `iconUrl` | string | no | Icon image URL |
| `capabilities` | object | no | `{ streaming, pushNotifications, stateTransitionHistory }` |
| `defaultInputModes` | string[] | no | MIME types accepted |
| `defaultOutputModes` | string[] | no | MIME types produced |
| `skills` | Skill[] | no | List of skill descriptors |

### Extended fields (SUI Agentic Registry)

#### `active`

```ts
active: boolean
```

Whether the agent is currently accepting requests. Mirrors the `active` field in the on-chain `AgentEntry`.

---

#### `services`

```ts
services: AgentService[]
```

```ts
interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
  skills?: string[];    // skill IDs from the skills array
  domains?: string[];   // free-form domain tags
}
```

Lists the A2A-compatible service endpoints exposed by this agent.

---

#### `registrations`

```ts
registrations: AgentRegistrationRef[]
```

```ts
interface AgentRegistrationRef {
  agentId: string;       // "sui:{network}:{registryObjectId}:{agentId}"
  agentRegistry: string; // "sui:{network}:{registryObjectId}"
}
```

On-chain registry references for this agent. Allows a single agent to appear in multiple registries (e.g., testnet + mainnet).

---

#### `supportedTrust`

```ts
supportedTrust: string[]
```

List of global agent IDs that this agent explicitly trusts. Mirrors the ERC-8004 `supportedTrust` concept. Used for agent-to-agent authorization.

---

## Discovery criteria mapping

Fields in the agent registration file map to server-side discovery filter parameters:

| `POST /discover` field | Source |
|---|---|
| `capability_codes` | `skills[*].id` or metadata key `capabilityCodes` |
| `compliance` | metadata key `compliance` (JSON array) |
| `jurisdiction` | metadata key `jurisdiction` |
| `min_reliability` | metadata key `reliability` (float 0–1) |
| `min_uptime_pct` | metadata key `uptimePct` (float 0–100) |
| `max_latency_p99_ms` | metadata key `slaGuarantees.latency_p99_ms` |
