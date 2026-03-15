# OpenEAGO Agent Registry

A reference implementation of a distributed agent registry for the [OpenEAGO](../../README.md) architecture. Agents register themselves, exchange capability metadata, and discover peers through bootstrap servers — all over mutual TLS enforced by [SPIRE](https://spiffe.io/docs/latest/spire-about/).

> **Reference implementation only.** Not intended for production use.

---

## Architecture

```log
Bootstrap server          Node agent
┌─────────────────┐          ┌──────────────┐
│  POST /register ◄──────────┤  on startup  │
│  GET  /list                │  sync loop   │
│  PUT  /status   ◄──────────┤  liveness    │
└─────────────────┘          └──────────────┘
```

**Bootstrap mode** (`bootstrap: true`) — accepts registrations, serves the full registry, and gossips peer lists back to callers.  
**Node mode** — registers with one or more bootstrap servers and periodically re-syncs.

All API traffic uses mTLS with SPIRE-issued X.509 SVIDs. The Swagger UI runs on a separate HTTP port that proxies to the mTLS backend.

---

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Rust | stable | `curl https://sh.rustup.rs -sSf \| sh` |
| pkg-config | any | `sudo apt install pkg-config` |
| jq | any | `sudo apt install jq` |
| SPIRE | 1.14.1 | see [Install SPIRE](#install-spire) |

---

## Setup (First Time)

Follow this order on a fresh machine:

1. Install Rust + pkg-config (see [Prerequisites](#prerequisites)).
2. Install SPIRE binaries.
3. Prepare SPIRE config and data directories.
4. Start SPIRE and fetch SVID files.
5. Start the registry and verify health.

### Install SPIRE

#### 1. Download from GitHub Releases

From the **agent-registry example directory** (`examples/agent-registry`):

```bash
cd examples/agent-registry   # or your path to the agent-registry example
export SPIRE_VERSION="1.14.1"
curl -Lo spire.tar.gz \
  "https://github.com/spiffe/spire/releases/download/v${SPIRE_VERSION}/spire-${SPIRE_VERSION}-linux-amd64-musl.tar.gz"
tar -xzf spire.tar.gz -C .
```

#### 2. Install binaries

```bash
# system-wide
sudo install -m 755 $PWD/spire-${SPIRE_VERSION}/bin/spire-server /usr/local/bin/
sudo install -m 755 $PWD/spire-${SPIRE_VERSION}/bin/spire-agent  /usr/local/bin/

# or user-local (~/.local/bin must be on PATH)
install -m 755 $PWD/spire-${SPIRE_VERSION}/bin/spire-server ~/.local/bin/
install -m 755 $PWD/spire-${SPIRE_VERSION}/bin/spire-agent  ~/.local/bin/
```

#### 3. Create config and data directories

```bash
mkdir -p spire-${SPIRE_VERSION}/{conf/server,conf/agent,data/server,data/agent}
```

`./spire-${SPIRE_VERSION}/conf/server/server.conf`:

```hcl
server {
    bind_address = "127.0.0.1"
    bind_port = "8081"
    trust_domain = "example.org"
    data_dir = "./spire-1.14.1/data/server"
    log_level = "INFO"
    ca_ttl = "168h"
    default_x509_svid_ttl = "48h"
}

plugins {
    DataStore "sql" {
        plugin_data {
            database_type = "sqlite3"
            connection_string = "./spire-1.14.1/data/server/datastore.sqlite3"
        }
    }
    KeyManager "disk" {
        plugin_data { keys_path = "./spire-1.14.1/data/server/keys.json" }
    }
    NodeAttestor "join_token" { plugin_data {} }
}
```

`./spire-${SPIRE_VERSION}/conf/agent/agent.conf`:

```hcl
agent {
    data_dir = "./spire-1.14.1/data/agent"
    log_level = "INFO"
    trust_domain = "example.org"
    server_address = "localhost"
    server_port = 8081
    insecure_bootstrap = true
}

plugins {
    KeyManager "disk" {
        plugin_data { directory = "./spire-1.14.1/data/agent" }
    }
    NodeAttestor "join_token" { plugin_data {} }
    WorkloadAttestor "unix"   { plugin_data {} }
}
```

> HCL path values are literal strings — `~` is not expanded. Relative paths in the config resolve against the working directory, so run SPIRE (and the steps below) from the `examples/agent-registry` directory.

### Start SPIRE and fetch SVID

Run all of the following from the **agent-registry example directory** (`examples/agent-registry`) so that the relative paths in the SPIRE configs resolve correctly.

If you opened a new shell, export the SPIRE version and go to the example directory:

```bash
export SPIRE_VERSION="1.14.1"
cd examples/agent-registry   # or your path to the agent-registry example
```

1. **Start the SPIRE server** (background):

```bash
spire-server run -config ./spire-${SPIRE_VERSION}/conf/server/server.conf &
```

2. **Generate a join token and start the SPIRE agent** (background). The `-spiffeID` is the agent’s identity after it joins.

```bash
TOKEN=$(spire-server token generate -spiffeID spiffe://example.org/agent | awk '{print $2}')
spire-agent run -config ./spire-${SPIRE_VERSION}/conf/agent/agent.conf -joinToken "$TOKEN" &
```

3. **Wait for the agent to join**, then create the workload registration (UID must match the user that will run the registry):

```bash
sleep 3
spire-server entry create \
  -parentID "spiffe://example.org/agent" \
  -spiffeID "spiffe://example.org/agent" \
  -selector unix:uid:$(id -u)
```

4. **Fetch the X.509 SVID and bundle to disk** (used by the registry for mTLS). The default agent socket path is `/tmp/spire-agent/public/api.sock`.

```bash
spire-agent api fetch x509 \
  -socketPath /tmp/spire-agent/public/api.sock \
  -write /tmp
```

The SVID cert, key, and bundle will be in `/tmp` (e.g. `svid.0.pem`, `svid.0.key`, `bundle.0.pem`).

**Stop SPIRE** when done (optional; stop before restarting server/agent):

```bash
pkill spire-agent
pkill spire-server
```

---

## Configuration

`config.bootstrap.yaml` (default config file):

```yaml
server:
  port: 8443           # mTLS HTTPS API port
  swagger_port: 8080   # HTTP Swagger UI port (localhost only)
  bootstrap: true      # run as bootstrap server
  max_ttl: 120         # seconds without contact → put agent in quarantine
  removal_ttl: 120     # seconds in quarantine → remove from registry

bootstrap:
  urls: []             # bootstrap server URLs for node mode
  sync_interval: 30    # re-registration interval (seconds) in node mode

agent:                 # metadata advertised when this instance registers
  instance_id: ~
  capability_codes: []
  version: ~
  jurisdiction: ~
  data_center: ~

spire:                 # SPIRE workload API certificate paths
  cert_path: /tmp/svid.0.pem    # SVID certificate (PEM)
  key_path:  /tmp/svid.0.key    # SVID private key (PEM)
  bundle_path: /tmp/bundle.0.pem # CA trust bundle (PEM)
  # Each path can also be set via SPIRE_CERT_PATH / SPIRE_KEY_PATH /
  # SPIRE_BUNDLE_PATH environment variables when not specified in the config.
```

Bootstrap eviction uses two TTLs: an agent that has not contacted the registry for `max_ttl` seconds is put in **quarantine** (still listed; `quarantined_at` is set). After another `removal_ttl` seconds in quarantine it is **removed** from the registry. Re-registering or receiving a gossip update clears quarantine.

### Start registry and verify

Start the registry:

```bash
cargo run --release -- --config config.bootstrap.yaml
```

Verify it is running:

```bash
curl -s https://localhost:8443/health \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key \
  --cacert /tmp/bundle.0.pem --insecure | jq
```

Swagger UI (no mTLS): <http://localhost:8080/swagger-ui/>

To stop the registry, interrupt it (Ctrl+C) or run: `pkill -f OpenEAGO-registry`.

> `--insecure` skips hostname verification only. SPIFFE SVIDs use URI SANs (`spiffe://…`), not DNS SANs. CA-chain trust is still enforced by the bundle.

### CLI flags (override config)

| Flag | Default | Description |
| --- | --- | --- |
| `--config` | `config.bootstrap.yaml` | Path to config file |
| `--port` | `8443` | mTLS API port |
| `--swagger-port` | `8080` | Swagger UI port |
| `--bootstrap` | — | Force bootstrap mode |
| `--bootstrap-url` | — | Add a bootstrap URL (repeatable) |
| `--sync-interval` | — | Override sync interval (seconds) |
| `--allow-insecure` | false | Fall back to HTTP when SPIRE certs are absent (**dev/test only**) |

---

## API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | mTLS | Liveness check |
| `GET` | `/list` | mTLS | List all registered agents |
| `POST` | `/register` | mTLS | Register or refresh an agent (bootstrap only) |
| `PUT` | `/status` | mTLS (owner) | Update reliability / health for own address |

Full schema: Swagger UI at `http://localhost:8080/swagger-ui/` while the server is running.

### Example: register an agent

```bash
curl -s -X POST https://localhost:8443/register \
  -H "Content-Type: application/json" \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key \
  --cacert /tmp/bundle.0.pem --insecure \
  -d '{
    "address": "localhost:8091",
    "known_bootstrap_urls": ["https://localhost:8443"],
    "agent_details": {
      "instance_id": "agent-001",
      "capability_codes": ["SPIRE_ENABLED"],
      "jurisdiction": "US",
      "data_center": "dc1",
      "compliance": ["SOC2"],
      "reliability": 0.99,
      "version": "0.1.0",
      "health_status": "healthy",
      "uptime_percentage": 99.9
    }
  }' | jq
```

### Example: list registered agents

```bash
curl -s https://localhost:8443/list \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key \
  --cacert /tmp/bundle.0.pem --insecure | jq
```

### Example: continuous monitoring (every 2 seconds)

```bash
watch -n 2 'curl -sS https://localhost:8443/list --cert /tmp/svid.0.pem --key /tmp/svid.0.key --cacert /tmp/bundle.0.pem --insecure | jq .'
```

### Example: update agent status

```bash
curl -s -X PUT https://localhost:8443/status \
  -H "Content-Type: application/json" \
  --cert /tmp/svid.0.pem --key /tmp/svid.0.key \
  --cacert /tmp/bundle.0.pem --insecure \
  -d '{"address": "localhost:8091", "health_status": "degraded", "reliability": 0.85}' | jq
```

---

## Security

- All API endpoints require a valid SPIRE X.509 SVID (mTLS).
- `PUT /status` additionally verifies the caller's peer IP matches the registered address, preventing agents from modifying each other's entries.
- The Swagger UI server binds to `127.0.0.1` only and proxies to the mTLS backend using the registry's own SVID.
- SPIRE cert paths default to the standard SPIRE workload API fetch output under `/tmp/`. Override them in the `spire:` section of the config file or via `SPIRE_CERT_PATH`, `SPIRE_KEY_PATH`, and `SPIRE_BUNDLE_PATH` environment variables.

---

## Testing

```bash
cargo test
```

---

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md).

## License

Apache 2.0 — see [LICENSE](../../LICENSE).
