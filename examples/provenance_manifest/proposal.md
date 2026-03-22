**Detailed summary of the conversation thread**  
This thread is an engineering research discussion focused on enhancing **OpenEAGO** (Open Enterprise Agent Governance and Orchestration Protocol — https://github.com/finos-labs/open-eago) with strong **evidentiary / forensic / audit-grade provenance** for AI agent invocations. The core goal is to make the entire chain **addressable, versioned, and immutable** from an evidence perspective — so that every decision or output can be later proven with cryptographic certainty (e.g., for regulatory audits, compliance, reproducibility, or liability questions in enterprise settings).

The discussion evolves step-by-step around what needs to be captured in a **provenance manifest** (a signed, structured record attached to OpenEAGO traces), building on the existing tracing extension (referenced as section 4.4 in "the paper" — likely an internal or draft research document not public on the repo as of March 2026).

### 1. Initial question: What's missing in the full invocation chain for evidence purposes?

**Original chain listed by user:**
- Caller
- MCP server (Multi-Agent Control Plane / orchestration layer)
- Agent code
- Model runtime
- Model training data
- Model vector data
- Model weights
- RAG

**Key insight:**  
Code (MCP server + agent code) is already well-covered via Git commit SHAs + CI/CD provenance (e.g. SLSA attestations).  
Everything below the code layer (runtime, weights, data, vectors, RAG) is typically **not** immutable or verifiable today — floating tags ("latest"), mutable repos, no frozen snapshots.

**Missing evidentiary pieces highlighted:**
- Governance/compliance validation layer
- Agent registry / negotiation
- Resilience & execution controls
- Context/state management
- Secure communication
- But reframed strictly for **bundling evidence**: runtime image digests, model weights hashes, dataset Merkle roots, vector index snapshots, retrieved RAG chunks hashes, prompt templates, etc.

**Proposed solution:** A **Provenance Manifest** (signed JSON/CBOR) attached to every trace that collects hashes/digests/locators for the full chain.

### 2. Follow-up: Should we add "sources" (locators + digests) directly into the manifest?

**Consensus:** Yes — strongly recommended (though optional in early spec versions).  
**Rationale:**
- Captures everything at invocation time (when resolution is possible).
- Enables offline cryptographic verification (fetch → re-hash → compare).
- Aligns with OpenEAGO's **audit anchoring** in the Communication & Delivery layer.
- Supports deterministic replay and regulatory needs (EU AI Act, DORA, etc.).

**Proposed structure snippet (sample JSON fragment):**

```json
{
  "invocation_id": "trace-uuid-1234",
  "trace_root": "openeago-trace-v4.4-root-hash",
  "sources": {
    "model_runtime": {
      "locator": "docker.io/vllm-project/vllm-openai@sha256:abcdef1234567890...",
      "sbom": {
        "format": "cyclonedx",
        "hash": "sha256:..."
      }
    },
    "model_weights": {
      "locator": "https://huggingface.co/meta-llama/Meta-Llama-3-8B-Instruct/tree/abcdef1234",
      "commit": "abcdef1234567890",
      "hash": "sha256:full-model-checkpoint-hash",
      "signature": {
        "type": "cosign",
        "bundle_url": "https://rekor.sigstore.dev/..."
      }
    },
    "rag_retrieved_chunks": {
      "index_snapshot": {
        "locator": "s3://company-rag-indexes/prod-v20260322-abc123",
        "hash": "sha256:index-file-hash"
      },
      "chunks": [
        {
          "source_doc_id": "doc-uuid-5678",
          "chunk_hash": "sha256:exact-chunk-content-hash",
          "retrieval_score": 0.92
        }
      ]
    }
    // ... training_data, vector_data, prompt_templates, etc.
  },
  "manifest_signature": {
    "algorithm": "ecdsa-secp256k1",
    "signer": "mcp-server-key-2026",
    "value": "...",
    "timestamp": "2026-03-22T14:30:00Z"
  }
}
```

### 3. Final point: Should sources be optional or mandatory?

**Decision:** **Optional** (pragmatic for early adoption in v0.1.x era).  
**But strongly recommended** — especially for regulated enterprises.

**Likelihood enterprises will populate them:**

| Artifact              | Enterprise Want/Need Level | Reason |
|-----------------------|-----------------------------|--------|
| Model weights hash + locator | Extremely high             | Core attack surface; already in many policies |
| Model runtime digest | Very high                  | SBOMs are becoming standard |
| RAG retrieved chunks hashes | High                       | Explainability / hallucination defense |
| Vector index snapshot | High                       | Drift detection |
| Training data Merkle root | Medium–high (rising)       | Hardest; EU AI Act pressure |

**Recommended spec guidance phrasing:**
- `sources` is optional to reduce barriers.
- Enterprises **SHOULD** populate at minimum: model_weights (locator + hash), model_runtime (digest), rag chunks/index hashes.
- When provided, manifest **SHOULD** be signed and anchored via OpenEAGO audit mechanism.

**Overall thread direction:**  
The conversation is driving OpenEAGO toward becoming a protocol that doesn't just orchestrate agents compliantly, but also produces **self-verifying, cryptographically provable inference records** — turning tracing (section 4.4) into full evidentiary bundles. This positions the project well for 2026–2027 regulated deployments in finance and other high-stakes domains.

Next likely research steps (implied): prototype the optional `sources` collection in the MCP server, test replay with sample traces, and gather feedback on which fields are easiest to populate in real pilots.