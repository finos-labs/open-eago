# Security Policy

## Supported Versions

Only the **latest published minor version** receives security fixes. Older pre-release versions are not backported.

| Version        | Supported          |
| -------------- | ------------------ |
| 0.1.x (latest) | :white_check_mark: |
| < 0.1          | :x:                |

Once the specification reaches stable v1.0 (targeted December 2026), this table will be updated to reflect the long-term support policy across major versions.

## Reporting a Vulnerability

OpenEMCP is a FINOS-hosted project. Security vulnerabilities should **not** be reported as public GitHub issues.

### Preferred Channel: GitHub Private Vulnerability Reporting

Use GitHub's built-in private security advisory feature:

1. Navigate to the [Security tab](https://github.com/finos-labs/open-emcp/security) of the repository.
2. Click **"Report a vulnerability"**.
3. Fill in the advisory form with as much detail as possible (see below).

This channel is monitored by the project maintainers and TSC Security Working Group, and keeps disclosure private until a fix is ready.

### Alternative Channel: FINOS Security

For vulnerabilities that may affect multiple FINOS projects, or if you prefer to contact FINOS staff directly, email: <security@finos.org>

### What to Include in Your Report

To help maintainers triage and reproduce the issue efficiently, please provide:

- A clear description of the vulnerability and its potential impact.
- The affected component(s): specification language, schema definitions, reference implementation (`examples/agent-registry`), or documentation.
- Steps to reproduce or a proof-of-concept if applicable.
- The version(s) or commit(s) where the issue was observed.
- Any suggested mitigations or relevant references (CVEs, RFCs, prior art).

### Response Timeline

| Event | Target |
| --- | --- |
| Initial acknowledgement | Within 3 business days |
| Triage and severity assessment | Within 7 calendar days |
| Status update to reporter | Every 14 calendar days until resolved |
| Security advisory publication | Coordinated with reporter after fix is merged |

Reporters are kept informed throughout the process. If a report is assessed as not a security vulnerability, the maintainers will explain the rationale and, where appropriate, open a public tracking issue.

### Coordinated Disclosure

OpenEMCP follows [coordinated vulnerability disclosure](https://vuls.cert.org/confluence/display/CVD). Maintainers ask reporters to allow a reasonable remediation window — typically 90 days from confirmation — before public disclosure. Expedited timelines can be negotiated for high-severity issues under active exploitation.

A public security advisory will be published via GitHub Security Advisories once a fix is available, crediting the reporter unless anonymity is requested.

## Scope

### In Scope

- Normative protocol specification language that could enable authentication bypass, privilege escalation, or data exposure in compliant implementations.
- JSON schema definitions under `spec/` that fail to enforce stated security invariants.
- The reference agent registry implementation under `examples/agent-registry` (Rust/actix-web), including TLS configuration, mTLS certificate handling, SPIFFE/SPIRE integration, and authentication logic.
- Documented security guidance (under `docs/overview/security.md`) that is materially incorrect or misleading.

### Out of Scope

- Vulnerabilities in third-party dependencies (please report those upstream; use `cargo audit` or similar to surface them).
- Issues that require physical access to infrastructure or involve already-compromised systems.
- Denial-of-service issues unless they affect availability guarantees stated in the specification.
- General implementation bugs with no security impact.

## Security Considerations for Implementers

OpenEMCP is designed for enterprise environments with strong security requirements. Implementers are expected to follow the guidance in [docs/overview/security.md](docs/overview/security.md), including:

- **Mutual TLS (mTLS)** for all inter-agent communication using SPIFFE/SPIRE-issued SVIDs.
- **OAuth 2.0 / SAML** for external authentication at the contract boundary.
- **RBAC/ABAC** for authorization enforcement aligned to enterprise policy.
- **Encryption in transit and at rest** for all agent-handled data.
- **Audit logging** of contract lifecycle events, agent enrollment, and policy decisions.

Deviation from these requirements may introduce vulnerabilities that are outside the project's direct control but could be reported as specification ambiguity (which is in scope).

## Security Working Group

The TSC Security Working Group coordinates security-relevant specification work. To participate, open a discussion in the repository or reach out through the FINOS project channels referenced in [GOVERNANCE.md](GOVERNANCE.md).
