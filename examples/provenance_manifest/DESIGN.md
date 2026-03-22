# Provenance Manifest — Architecture & Design Rationale

## Overview

The Provenance Manifest extends OpenEAGO's tracing layer (section 4.4) with a
**signed, structured record** that cryptographically anchors every component in
an AI agent invocation chain.  The goal is to produce self-verifying,
audit-grade inference records suitable for regulated enterprise deployments
(EU AI Act, DORA, financial compliance).

---

## Module Layout

```
provenance_manifest/
├── models.py      — Pydantic v2 data models (JSON schema)
├── collector.py   — Artifact collection helpers (hash-and-assemble)
├── signer.py      — ECDSA P-256 sign + verify
└── verifier.py    — Full manifest verification with structured results
```

---

## Manifest JSON Model

A fully-populated manifest (all source fields present) looks like this:

```json
{
  "invocation_id": "inv-2024-03-22-financial-7b-001",
  "trace_root": "trace-root-sha256-fedcba9876543210",
  "created_at": "2024-03-22T14:05:00.123456+00:00",
  "sources": {
    "model_runtime": {
      "locator": "ghcr.io/finos-labs/open-eago-agent@sha256:abc123def456",
      "sbom": {
        "format": "cyclonedx-json",
        "hash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
      }
    },
    "model_weights": {
      "locator": "hf://finos-labs/open-eago-financial-7b",
      "commit": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      "hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "signature": {
        "type": "cosign",
        "bundle_url": "https://rekor.sigstore.dev/api/v1/log/entries/abc123"
      }
    },
    "rag": {
      "index_snapshot": {
        "locator": "s3://finos-labs-vectors/financial-compliance-v3/snapshot-2024-03-01",
        "hash": "sha256:b94f6f125c79e3a5ffaa826f584c10d52ada669e6762051b826b55776d05a8d7"
      },
      "chunks": [
        {
          "source_doc_id": "doc-regulatory-guidelines-2024",
          "chunk_hash": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          "retrieval_score": 0.92
        },
        {
          "source_doc_id": "doc-dora-technical-standards",
          "chunk_hash": "sha256:82e35a63ceba37e9646434c5dd412ea577147f1e4a41ccde1614253187e3dbbc",
          "retrieval_score": 0.87
        }
      ]
    },
    "training_data": {
      "locator": "s3://finos-labs-datasets/financial-instruct-v2.tar.gz",
      "hash": "sha256:4e07408562bedb8b60ce05c1decf3ad7b3d191b4b7f705e37cd40e8abe8b2e6c",
      "merkle_root": "sha256:1a79a4d60de6718e8e5b326e338ae533"
    },
    "vector_index": {
      "locator": "pgvector://prod-db/schema.embeddings_v3",
      "hash": "sha256:ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
      "snapshot_ts": "2024-03-01T00:00:00+00:00"
    },
    "prompt_template": {
      "name": "financial-compliance-assistant",
      "version": "2.1.0",
      "hash": "sha256:3fdba35f04dc8c462986c992bcf875546169049237a04d51de99e41f0bb4a5c6"
    },
    "grounding_citations": {
      "citations": [
        {
          "url": "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689",
          "title": "EU AI Act — Official Journal of the European Union",
          "retrieved_at": "2024-03-22T14:04:55+00:00",
          "content_hash": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          "provider": "google-search"
        },
        {
          "url": "https://www.eba.europa.eu/sites/default/files/2024-01/DORA_consolidated.pdf",
          "title": "DORA Consolidated Text — EBA",
          "retrieved_at": "2024-03-22T14:04:57+00:00",
          "content_hash": "sha256:82e35a63ceba37e9646434c5dd412ea577147f1e4a41ccde1614253187e3dbbc",
          "provider": "google-search"
        }
      ]
    }
  },
  "manifest_signature": {
    "algorithm": "ECDSA-P256-SHA256",
    "signer": "openEAGO-demo-signer-v1",
    "value": "MEYCIQDx7k3v...base64url-encoded-DER-signature...==",
    "timestamp": "2024-03-22T14:05:01.456789+00:00"
  }
}
```

### Field reference

| Field | Type | Description |
|---|---|---|
| `invocation_id` | string | Unique ID for this inference call |
| `trace_root` | string | Root span ID from the distributed trace |
| `created_at` | ISO-8601 | Manifest creation time (UTC) |
| `sources.model_runtime.locator` | string | OCI image ref including digest |
| `sources.model_runtime.sbom.hash` | `sha256:<hex>` | Hash of the CycloneDX/SPDX SBOM |
| `sources.model_weights.commit` | string | Exact model version (git SHA or tag) |
| `sources.model_weights.hash` | `sha256:<hex>` | Hash of weights artifact |
| `sources.model_weights.signature` | object | Optional cosign/sigstore bundle ref |
| `sources.rag.index_snapshot.hash` | `sha256:<hex>` | Hash of serialised vector index |
| `sources.rag.chunks[].chunk_hash` | `sha256:<hex>` | Per-chunk content hash |
| `sources.rag.chunks[].retrieval_score` | float | Similarity score at retrieval time |
| `sources.training_data.merkle_root` | `sha256:<hex>` | Optional Merkle root over dataset shards |
| `sources.vector_index.snapshot_ts` | ISO-8601 | When the index snapshot was taken |
| `sources.prompt_template.hash` | `sha256:<hex>` | Hash of raw template text |
| `sources.grounding_citations.citations[].url` | string | Canonical URL of the cited external source |
| `sources.grounding_citations.citations[].retrieved_at` | ISO-8601 | When the URL was fetched |
| `sources.grounding_citations.citations[].content_hash` | `sha256:<hex>` | Hash of fetched content at retrieval time |
| `sources.grounding_citations.citations[].provider` | string | Search/grounding provider (e.g. `"google-search"`) |
| `manifest_signature.value` | base64url | DER-encoded ECDSA signature (no padding) |

All `sources.*` fields are **optional** — omit any that are not applicable.
The `manifest_signature` field is excluded from the signed payload; everything
else is covered.

---

## Design Decisions

### 1. Pydantic v2 for schema enforcement

All manifest fields are typed Pydantic `BaseModel` subclasses.  Optional
fields mean partial manifests (e.g. no RAG source) are valid — the verifier
notes only the sources that are present.  `model_dump(mode="json")` produces
JSON-safe dicts without custom serializers.

### 2. Canonical bytes for signing

`ProvenanceManifest.canonical_bytes()` serialises the manifest to
deterministic JSON (sorted keys, no whitespace) with `manifest_signature`
excluded.  This matches the pattern used in `shared/prompt_hash.py` and
ensures the signed payload is byte-for-byte reproducible regardless of
field insertion order.

### 3. ECDSA P-256 via `cryptography`

The `cryptography` package (Apache-2.0) provides FIPS-aligned ECDSA P-256
(secp256r1) without requiring blockchain toolchains or network access.
DER-encoded signatures are stored as base64url strings (RFC 4648 §5, no
padding) in `ManifestSignature.value`.

In production the private key would live in a HSM / Vault Transit secret
engine / AWS KMS, replacing only the `sign_manifest` internals — the manifest
schema and verification logic remain unchanged.

### 4. Structured VerificationResult

`VerificationResult` separates passing `checks` from `failures` so audit
tooling can surface granular evidence rather than a single boolean.  Each
populated source field generates an independent check line, enabling partial
trust decisions (e.g. signature valid but weights not re-fetched yet).

### 5. rehash_artifact stubs

`verifier.rehash_artifact` is intentionally a stub.  Real implementations
would stream the artifact from its `locator`, compute SHA-256, and compare
against the stored hash.  The stub pattern keeps the demo runnable without
registry access while making the integration point explicit.

---

## Compliance Alignment

| Requirement | How manifest addresses it |
|---|---|
| EU AI Act Art. 13 — Transparency | `invocation_id` + `trace_root` link manifest to LLM trace |
| EU AI Act Art. 9 — Risk management | All model component hashes enable post-hoc audit |
| DORA Art. 6 — ICT risk | Signed manifest provides tamper evidence for incident response |
| SOC 2 CC6.1 — Logical access | `signer` field records which key/service produced the manifest |

---

## Extension Points

- **Keyless signing**: replace `signer.py` with a Sigstore/Fulcio workflow for
  certificate-backed, identity-rooted signatures without long-lived key material.
- **On-chain anchoring**: hash the canonical bytes and store on a public ledger
  for independent timestamp verification.
- **Streaming RAG**: extend `RagSource` with a Merkle tree over all chunks so
  individual chunks can be verified without the full index snapshot.
- **MCP integration**: emit the manifest as a structured tool-call result in the
  OpenEAGO MCP server so orchestrators can attach provenance to every response.
