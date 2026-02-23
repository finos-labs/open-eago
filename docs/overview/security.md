# Component Security Overview

## What is SPIRE?

**SPIRE** (SPIFFE Runtime Environment) is a production-ready implementation of the SPIFFE (Secure Production Identity Framework For Everyone) specification. It provides a unified identity control plane that automatically issues, rotates, and manages X.509 certificates (called SVIDs - SPIFFE Verifiable Identity Documents) for workloads in dynamic, heterogeneous environments.
Think of SPIRE as an "identity factory" for your services - instead of managing SSH keys, passwords, or API tokens, every service gets a cryptographically verifiable identity that proves who it is, not just where it runs.

## Architecture Overview
```mermaid
graph TB
   subgraph "SPIRE Infrastructure"
       Server[SPIRE Server<br/>Port: Unix Socket<br/>DB: SQLite<br/>CA: Root Certificate]
       Agent[SPIRE Agent<br/>Socket: /tmp/spire-agent/<br/>public/api.sock<br/>Caches SVIDs]
       Server -->|Issues & Signs<br/>X.509 SVIDs| Agent
   end
   subgraph "Workloads"
       Registry[Registry Rust/actix-web<br/>ID: spiffe://example.org/registry<br/>Port: 8443 HTTPS]
       MCP[MCP Agent Python<br/>ID: spiffe://example.org/mini-agent<br/>Port: 9000 HTTP]
   end
   Agent -->|Workload API<br/>Fetch SVID| Registry
   Agent -->|Workload API<br/>Fetch SVID| MCP
   MCP -->|HTTPS + mTLS<br/>POST /register| Registry
```

**Key Components:**
- **SPIRE Server**: Acts as the Certificate Authority (CA) and identity control plane. It stores registration entries (which workloads are allowed) and issues signed certificates.
- **SPIRE Agent**: Runs on each node, attests workload identity (verifies "you are who you say you are"), and delivers certificates via a Unix domain socket.
- **Registry**: Rust service that accepts agent registrations over HTTPS, requires client certificates for authentication.
- **MCP Agent**: Python service that registers with the registry, fetches its identity from SPIRE, and uses mTLS for secure communication.

## Flow 1: Registration Entry Creation
```mermaid
sequenceDiagram
   participant Admin
   participant Server as SPIRE Server
   participant DB as Registration Database
   Admin->>Server: spire-server entry create<br/>-spiffeID spiffe://example.org/registry<br/>-selector unix:uid:1000<br/>-dns localhost
   Server->>DB: Store Registration Entry
   DB-->>Server: Entry Stored
   Server-->>Admin: Entry ID: abbdf022-...<br/>SPIFFE ID: .../registry<br/>Selector: unix:uid:1000
   Note over DB: Registration Entry<br/>┌──────────────────────┐<br/>SPIFFE ID: .../registry<br/>Selector: unix:uid:1000<br/>TTL: 48 hours<br/>DNS: localhost<br/>└──────────────────────┘
```

**What's happening:**
1. Administrator creates a "registration entry" - a policy that says "any process running as UID 1000 can get an identity of `spiffe://example.org/registry`"
2. SPIRE Server stores this entry in its database
3. The entry includes selectors (attestation criteria), TTL (certificate lifetime), and DNS names
**Why it matters:** This is the authorization step - you're telling SPIRE "these workloads are allowed to exist in my infrastructure."

## Flow 2: SVID Issuance (Getting Certificates)
```mermaid
sequenceDiagram
   participant Registry as Registry Process<br/>(UID: 1000)
   participant Agent as SPIRE Agent
   participant Server as SPIRE Server
   participant CA as CA Private Key
   Registry->>Agent: 1. Fetch SVID via Workload API<br/>(Unix socket request)
   Note over Agent: 2. Workload Attestation<br/>Check process attributes:<br/>- UID: 1000 ✓<br/>- GID: 1000 ✓<br/>- Process path: /target/release/openemcp-registry ✓
   Agent->>Server: 3. Request SVID for<br/>unix:uid:1000
   Server->>Server: 4. Lookup registration entry<br/>unix:uid:1000 → spiffe://example.org/registry
   Server->>CA: 5. Generate & sign certificate<br/>Subject: CN=registry<br/>SAN URI: spiffe://example.org/registry
   CA-->>Server: Signed X.509 Certificate
   Server-->>Agent: 6. Return SVID Bundle:<br/>- Certificate (svid.0.pem)<br/>- Private Key (svid.0.key)<br/>- CA Bundle (bundle.0.pem)
   Agent->>Agent: Cache SVID (48h TTL)
   Agent-->>Registry: 7. Deliver SVID files to /tmp/
   Note over Registry: Registry now has:<br/>/tmp/svid.0.pem (certificate)<br/>/tmp/svid.0.key (private key)<br/>/tmp/bundle.0.pem (trust root)
```

**What's happening:**
1. **Registry requests identity**: Process calls SPIRE Agent via Unix socket
2. **Agent attests workload**: Verifies the process matches the selector (UID 1000)
3. **Agent requests certificate**: Asks SPIRE Server for an SVID
4. **Server looks up policy**: Finds the matching registration entry
5. **Server signs certificate**: Creates an X.509 cert with the SPIFFE ID in the Subject Alternative Name (SAN)
6. **SVID delivered**: Certificate, private key, and CA bundle returned
7. **Files written**: Agent writes certificates to `/tmp/` for the workload to use
**Why it matters:** This is the authentication step - SPIRE cryptographically proves the workload's identity without passwords or API keys.

## Flow 3: mTLS Communication
```mermaid
sequenceDiagram
   participant MCP as MCP Agent<br/>(spiffe://example.org/mini-agent)
   participant TLS as TLS Layer
   participant Registry as Registry<br/>(spiffe://example.org/registry)
   Note over MCP: Has certificate:<br/>svid.1.pem + svid.1.key
   Note over Registry: Has certificate:<br/>svid.0.pem + svid.0.key
   MCP->>TLS: 1. TLS ClientHello<br/>+ Client Certificate (svid.1.pem)<br/>+ Supported Ciphers
   TLS->>Registry: Forward ClientHello + Client Cert
   Registry->>Registry: 2. Verify Client Certificate<br/>✓ Signed by bundle.0.pem?<br/>✓ SPIFFE ID valid?<br/>✓ Not expired?
   Registry->>TLS: 3. TLS ServerHello<br/>+ Server Certificate (svid.0.pem)<br/>+ Selected Cipher: AES-256-GCM
   TLS->>MCP: Forward ServerHello + Server Cert
   MCP->>MCP: 4. Verify Server Certificate<br/>✓ Signed by bundle.1.pem?<br/>✓ SPIFFE ID = .../registry?<br/>✓ Not expired?
   Note over MCP,Registry: ✓ Mutual Authentication Complete<br/>✓ Symmetric keys exchanged<br/>✓ Encrypted channel established
   MCP->>Registry: 5. Encrypted Request<br/>POST /register<br/>{"address": "172.17.0.4:9000", ...}
   Registry->>Registry: 6. Process Registration<br/>Store agent details in registry
   Registry->>MCP: 7. Encrypted Response<br/>{"success": true, "known_addresses": [...]}
   Note over MCP,Registry: Connection secured by:<br/>- Encryption: AES-256-GCM<br/>- Authentication: Both identities verified<br/>- Integrity: HMAC on all messages
```

**What's happening:**

1. **Client initiates**: MCP Agent starts TLS handshake and presents its certificate
2. **Server verifies client**: Registry checks if client cert is signed by trusted CA and contains valid SPIFFE ID
3. **Server responds**: Registry presents its own certificate
4. **Client verifies server**: MCP Agent validates registry's certificate
5. **Encrypted communication**: After mutual authentication, all data is encrypted with symmetric keys
6. **Application logic**: Registry processes the registration request
7. **Encrypted response**: Registry sends response back through encrypted channel
   
**Why it matters:**

- **Traditional HTTPS**: Only server proves identity (client could be anyone)
- **mTLS**: Both parties prove identity cryptographically
- **Zero-Trust**: No reliance on network perimeter, VPN, or IP whitelist

## Certificate Structure
```mermaid
graph LR
   subgraph "X.509 SVID Certificate"
       A[Subject: CN=registry]
       B[Issuer: SPIRE CA]
       C[Validity: 48 hours]
       D[Extensions]
       E[Public Key: RSA 2048]
       F[Signature]
   end
   subgraph "Critical Extension: SAN"
       G[URI: spiffe://example.org/registry]
       H[DNS: localhost]
       I[DNS: 127.0.0.1]
   end
   D --> G
   D --> H
   D --> I
   subgraph "Trust Chain"
       J[SPIRE Root CA]
       K[Intermediate CA]
       L[SVID Certificate]
   end
   J -->|Signs| K
   K -->|Signs| L
```
**Key Fields:**
- **Subject**: Common Name (CN) - human-readable identifier
- **Issuer**: The SPIRE CA that signed this certificate
- **Validity**: 48-hour lifetime (default) - forces automatic rotation
- **Subject Alternative Name (SAN)**: Contains the SPIFFE ID URI - this is the actual identity!
- **Public Key**: Used for encryption and signature verification
- **Signature**: Proves the certificate was issued by the trusted CA
**SPIFFE ID Format**: `spiffe://trust-domain/workload-identifier`
- `spiffe://`: Protocol identifier
- `example.org`: Trust domain (logical grouping of services)
- `/registry`: Workload-specific identifier

## Security Comparison
```mermaid
graph TD
   subgraph "Traditional HTTPS Only"
       A1[Client] -->|1. No client cert| B1[Server]
       B1 -->|2. Server cert| A1
       A1 -->|3. Request| B1
       Note1[Disadvantages:<br/>- Client anonymous<br/>- Relies on network security<br/>- IP-based trust]
   end
   subgraph "SPIRE mTLS"
       A2[Client<br/>spiffe://.../mini-agent] -->|1. Client cert + identity| B2[Server<br/>spiffe://.../registry]
       B2 -->|2. Server cert + identity| A2
       A2 -->|3. Encrypted request| B2
       Note2[Advantages:<br/>- Both parties authenticated<br/>- Cryptographic identity<br/>- Zero-trust architecture]
   end
```
| Security Aspect | Traditional TLS | SPIRE mTLS |
|-----------------|-----------------|------------|
| **Server Authentication** | ✓ (DNS + Public CA) | ✓ (SPIFFE ID + Private CA) |
| **Client Authentication** | ✗ (or API keys) | ✓ (X.509 certificate) |
| **Identity Type** | DNS hostname | SPIFFE URI |
| **Certificate Issuance** | Manual (Let's Encrypt, etc.) | Automatic (SPIRE) |
| **Rotation** | Manual, 90 days | Automatic, 48 hours |
| **Trust Model** | Network perimeter | Cryptographic proof |
| **Compromised Credentials** | Must manually revoke | Auto-expires in 48h max |
| **Works Across Networks** | Same datacenter only | Yes, anywhere |

## Complete End-to-End Flow
```mermaid
sequenceDiagram
   autonumber
   participant Admin
   participant Server as SPIRE Server
   participant Agent as SPIRE Agent
   participant Registry as Registry (Rust)
   participant MCP as MCP Agent (Python)
   Note over Admin,Server: Phase 1: Setup & Registration
   Admin->>Server: Create registry entry<br/>(spiffe://example.org/registry)
   Admin->>Server: Create mini-agent entry<br/>(spiffe://example.org/mini-agent)
   Note over Registry,Agent: Phase 2: Registry Startup
   Registry->>Agent: Fetch my SVID (Workload API)
   Agent->>Server: Request SVID for unix:uid:1000
   Server-->>Agent: Issue SVID (svid.0.pem)
   Agent-->>Registry: Deliver certificates to /tmp/
   Registry->>Registry: Load certificates<br/>Start HTTPS on port 8443<br/>Enable client cert verification
   Note over MCP,Agent: Phase 3: MCP Agent Startup
   MCP->>Agent: Fetch my SVID (Workload API)
   Agent->>Server: Request SVID for unix:uid:1000
   Server-->>Agent: Issue SVID (svid.1.pem)
   Agent-->>MCP: Deliver certificates to /tmp/
   Note over MCP,Registry: Phase 4: Registration via mTLS
   MCP->>Registry: TLS Handshake + Client Cert
   Registry->>Registry: Verify client cert against CA bundle
   Registry->>MCP: Server Cert
   MCP->>MCP: Verify server cert against CA bundle
   Note over MCP,Registry: ✓ Mutual authentication complete
   MCP->>Registry: POST /register (encrypted)
   Registry->>Registry: Store agent in registry
   Registry->>MCP: 200 OK (encrypted)
   Note over MCP,Agent: Phase 5: Automatic Rotation (every 24h)
   Agent->>Server: Renew SVID (before expiry)
   Server-->>Agent: New SVID (fresh 48h TTL)
   Agent-->>MCP: Update certificates in /tmp/
   MCP->>MCP: Reload certificates<br/>Continue using same connection
```

## Benefits Summary

**Zero-Trust Architecture**: Services authenticate based on cryptographic identity, not network location  
**Automatic Certificate Management**: No manual certificate renewal or deployment  
**Short-Lived Credentials**: 48-hour TTL limits blast radius of compromised keys  
**Mutual Authentication**: Both client and server prove their identity  
**Platform-Agnostic**: Works across Kubernetes, VMs, containers, bare metal  
**Audit Trail**: Every identity issuance is logged with attestation data  
**No Shared Secrets**: Each workload gets unique keys, no password sharing  
**Defense in Depth**: Even if network is compromised, service-to-service communication remains secure

---

**Result**: A production-ready, zero-trust identity system where workloads authenticate using automatically-managed X.509 certificates with SPIFFE IDs, eliminating password-based authentication and enabling secure service-to-service communication across any network.