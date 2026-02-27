# RFC: OpenEMCP - Agent Registry

**Version:** 0.1.0  
**Status:** Active Development  
**Last Updated:** 2026-02-24  
**Authors:** OpenEMCP Team

---

## Introduction

The Agent Registry is a core component of the OpenEMCP architecture, responsible for managing the lifecycle of agents within the system. It provides functionalities for registering, updating, and deregistering agents, as well as maintaining a directory of available agents and their capabilities.

**Important:** This is a reference implementation of the Agent Registry. It is not intended for production use and may contain bugs or security vulnerabilities. Use at your own risk.

## Prerequisites

### Install SPIRE (replacing the local copy)

#### 1. Download from GitHub Releases

```bash
export SPIRE_VERSION="1.14.1"
cd /tmp
curl -Lo spire.tar.gz "https://github.com/spiffe/spire/releases/download/v${SPIRE_VERSION}/spire-${SPIRE_VERSION}-linux-amd64-musl.tar.gz"
tar -xzf spire.tar.gz
```

#### 2. Install binaries system-wide

```bash
sudo install -m 755 spire-${SPIRE_VERSION}/bin/spire-server /usr/local/bin/
sudo install -m 755 spire-${SPIRE_VERSION}/bin/spire-agent  /usr/local/bin/
```

Or user-local (~/.local/bin must be on PATH):

```bash
install -m 755 spire-${SPIRE_VERSION}/bin/spire-server ~/.local/bin/
install -m 755 spire-${SPIRE_VERSION}/bin/spire-agent  ~/.local/bin/
```

#### 3. Set up config and data dirs

```bash
mkdir -p ~/spire/{conf/server,conf/agent,data/server,data/agent}
```

~/spire/conf/server/server.conf — copy from server.conf, update data_dir:

```json
agent {
    data_dir = "/home/vscode/spire/data/agent"
    log_level = "DEBUG"
    trust_domain = "example.org"
    server_address = "localhost"
    server_port = 8081
    insecure_bootstrap = true
}

plugins {
    KeyManager "disk" {
        plugin_data {
            directory = "/home/vscode/spire/data/agent"
        }
    }

    NodeAttestor "join_token" {
        plugin_data {}
    }

    WorkloadAttestor "unix" {
        plugin_data {}
    }
}
```

~/spire/conf/agent/agent.conf — copy from agent.conf, update data_dir:

```json
server {
    bind_address = "127.0.0.1"
    bind_port = "8081"
    trust_domain = "example.org"
    data_dir = "/home/vscode/spire/data/server"
    log_level = "DEBUG"
    ca_ttl = "168h"
    default_x509_svid_ttl = "48h"
}

plugins {
    DataStore "sql" {
        plugin_data {
            database_type = "sqlite3"
            connection_string = "/home/vscode/spire/data/server/datastore.sqlite3"
        }
    }

    KeyManager "disk" {
        plugin_data {
            keys_path = "/home/vscode/spire/data/server/keys.json"
        }
    }

    NodeAttestor "join_token" {
        plugin_data {}
    }
}
```

#### 4. Run (mirrors what setup_spire.sh does)

```bash
# Start server (background)
spire-server run -config ~/spire/conf/server/server.conf &

# Verify server is running
netstat -tulpn | grep 8081
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name    
tcp        0      0 127.0.0.1:8081          0.0.0.0:*               LISTEN      9051/rosetta        

# Generate a join token
TOKEN=$(spire-server token generate -spiffeID spiffe://example.org/agent | awk '{print $2}')
echo "Token: $TOKEN"

# Start agent
spire-agent run -config ~/spire/conf/agent/agent.conf -joinToken "$TOKEN" &
```

#### 5. Run with quick start script

```bash
./scripts/quick_start.sh
```

output:

```log
./quick_start.sh 
╔════════════════════════════════════════════════╗
║  OpenEMCP Registry + SPIRE Quick Start         ║
╚════════════════════════════════════════════════╝

✓ SPIRE is already running

Registering workload entry...
  Agent ID: spiffe://example.org/spire/agent/join_token/f3a79052-f2ef-41d6-b894-99d408a12486
  Deleting stale entry: 057bd539-680d-4c7f-b233-1913fe3d0d57
Deleted entry with ID: 057bd539-680d-4c7f-b233-1913fe3d0d57


Deleted 1 entries successfullyEntry ID         : 37794fa5-d3d2-4199-a53b-1050bd3a320f
SPIFFE ID        : spiffe://example.org/agent
Parent ID        : spiffe://example.org/spire/agent/join_token/f3a79052-f2ef-41d6-b894-99d408a12486
Revision         : 0
X509-SVID TTL    : default
JWT-SVID TTL     : default
Selector         : unix:uid:1000

✓ Workload entry registered (uid=1000)

Fetching SPIRE SVID...
Received 1 svid after 14.452584ms

SPIFFE ID:              spiffe://example.org/agent
SVID Valid After:       2026-02-26 13:56:25 +0000 UTC
SVID Valid Until:       2026-02-28 13:56:35 +0000 UTC
CA #1 Valid After:      2026-02-26 12:26:01 +0000 UTC
CA #1 Valid Until:      2026-03-05 12:26:11 +0000 UTC

Writing SVID #0 to file /tmp/svid.0.pem.
Writing key #0 to file /tmp/svid.0.key.
Writing bundle #0 to file /tmp/bundle.0.pem.
✓ SVID fetched successfully

Building registry...
    Finished `release` profile [optimized] target(s) in 0.25s

═══════════════════════════════════════════════
Setup complete! Ready to start services.
═══════════════════════════════════════════════

Next steps:

1. Start the registry (bootstrap server):
   cargo run --release -- --config config.bootstrap.yaml

2. Quick curl test:
   curl -X GET https://localhost:8443/health \
     --cert /tmp/svid.0.pem \
     --key /tmp/svid.0.key \
     --cacert /tmp/bundle.0.pem \
     --insecure -s | jq
   # --insecure skips hostname verification; required because SPIFFE SVIDs use
   # URI SANs (spiffe://...) rather than DNS SANs. CA trust is still enforced.
```

#### 6. Install Cargo (Rust)

```bash
curl https://sh.rustup.rs -sSf | sh
```

#### 7. Install pkg-config (for building Rust dependencies)

```bash
sudo apt install pkg-config
```

#### 8. Build and run the registry (bootstrap server)

```bash
# Build the registry:
cargo build --release

# Start the registry (bootstrap server):
cargo run --release -- --bootstrap true
# Or with custom config file and port:
cargo run --release -- --config config.bootstrap.yaml --port 8443

# Quick curl test:
curl -X GET https://localhost:8443/health \
  --cert /tmp/svid.0.pem \
  --key /tmp/svid.0.key \
  --cacert /tmp/bundle.0.pem \
  --insecure -s | jq
# --insecure skips hostname verification; required because SPIFFE SVIDs use
# URI SANs (spiffe://...) rather than DNS SANs. CA trust is still enforced.
```
