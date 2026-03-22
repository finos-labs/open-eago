#!/usr/bin/env python3
"""Demo: build, sign, and verify a Provenance Manifest end-to-end.

Scenario: a financial-services AI agent performs an inference.  We capture
every component (runtime, model weights, RAG index + chunks, prompt template)
into a cryptographically signed ProvenanceManifest suitable for EU AI Act /
DORA audit trails.

Run:
    cd examples/provenance_manifest
    pip install -e .
    python demo.py
"""

import json

from provenance_manifest import (
    ManifestSources,
    build_manifest,
    collect_grounding_citations,
    collect_model_runtime,
    collect_model_weights,
    collect_prompt_template,
    collect_rag_chunks,
    generate_key_pair,
    sign_manifest,
    verify_manifest,
)

# ---------------------------------------------------------------------------
# 1. Generate an ephemeral ECDSA P-256 key pair
#    (in production: loaded from a HSM / Vault / KMS)
# ---------------------------------------------------------------------------
print("=" * 64)
print("OpenEAGO Provenance Manifest — End-to-End Demo")
print("=" * 64)

print("\n[1] Generating ECDSA P-256 key pair ...")
private_pem, public_pem = generate_key_pair()
print("    Key pair generated (private key stays in memory, not persisted).")

# ---------------------------------------------------------------------------
# 2. Simulate collecting all source artifacts
# ---------------------------------------------------------------------------
print("\n[2] Collecting source artifacts ...")

# Model runtime: OCI image with SBOM
sbom_content = b'{"bomFormat":"CycloneDX","specVersion":"1.4","components":[]}'
runtime_src = collect_model_runtime(
    image_ref="ghcr.io/finos-labs/open-eago-agent@sha256:abc123def456",
    sbom_data=sbom_content,
)
print(f"    runtime  : {runtime_src.locator}")
print(f"    sbom hash: {runtime_src.sbom.hash}")

# Model weights: HuggingFace repo
weights_bytes = b"<simulated-model-weights-binary-blob>"
weights_src = collect_model_weights(
    locator="hf://finos-labs/open-eago-financial-7b",
    commit="a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    content_bytes=weights_bytes,
)
print(f"    weights  : {weights_src.locator} @ {weights_src.commit[:12]}...")
print(f"    hash     : {weights_src.hash}")

# RAG source: index snapshot + retrieved chunks
rag_index_bytes = b"<serialised-faiss-index-snapshot>"
rag_src = collect_rag_chunks(
    chunks=[
        {
            "source_doc_id": "doc-regulatory-guidelines-2024",
            "content": b"Article 13: Transparency obligations for high-risk AI systems...",
            "retrieval_score": 0.92,
        },
        {
            "source_doc_id": "doc-dora-technical-standards",
            "content": b"Section 4.2: ICT risk management requirements for financial entities...",
            "retrieval_score": 0.87,
        },
    ],
    index_locator="s3://finos-labs-vectors/financial-compliance-v3/snapshot-2024-03-01",
    index_bytes=rag_index_bytes,
)
print(f"    rag index: {rag_src.index_snapshot.locator}")
print(f"    chunks   : {len(rag_src.chunks)} retrieved")

# Prompt template
prompt_content = (
    "You are a compliance assistant for financial services.\n"
    "Answer only based on the provided regulatory context.\n"
    "Context: {{context}}\nQuestion: {{question}}"
)
prompt_src = collect_prompt_template(
    name="financial-compliance-assistant",
    version="2.1.0",
    content=prompt_content,
)
print(f"    prompt   : {prompt_src.name} v{prompt_src.version}")
print(f"    hash     : {prompt_src.hash}")

# Grounding citations: external sources fetched at inference time
citations_src = collect_grounding_citations(
    citations=[
        {
            "url": "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32024R1689",
            "title": "EU AI Act — Official Journal of the European Union",
            "retrieved_at": "2024-03-22T14:04:55+00:00",
            "content": b"Regulation (EU) 2024/1689 of the European Parliament...",
            "provider": "google-search",
        },
        {
            "url": "https://www.eba.europa.eu/sites/default/files/2024-01/DORA_consolidated.pdf",
            "title": "DORA Consolidated Text — EBA",
            "retrieved_at": "2024-03-22T14:04:57+00:00",
            "content": b"Digital Operational Resilience Act (DORA) consolidated...",
            "provider": "google-search",
        },
    ]
)
print(f"    citations: {len(citations_src.citations)} grounding source(s) recorded")
for c in citations_src.citations:
    print(f"      [{c.provider}] {c.url}")
    print(f"       hash: {c.content_hash}")

# ---------------------------------------------------------------------------
# 3. Build the ProvenanceManifest
# ---------------------------------------------------------------------------
print("\n[3] Building ProvenanceManifest ...")
sources = ManifestSources(
    model_runtime=runtime_src,
    model_weights=weights_src,
    rag=rag_src,
    prompt_template=prompt_src,
    grounding_citations=citations_src,
)
manifest = build_manifest(
    invocation_id="inv-2024-03-22-financial-7b-001",
    trace_root="trace-root-sha256-fedcba9876543210",
    sources=sources,
)
print(f"    invocation_id : {manifest.invocation_id}")
print(f"    trace_root    : {manifest.trace_root}")
print(f"    created_at    : {manifest.created_at}")

# ---------------------------------------------------------------------------
# 4. Sign the manifest
# ---------------------------------------------------------------------------
print("\n[4] Signing manifest (ECDSA P-256 / SHA-256) ...")
signed = sign_manifest(
    manifest=manifest,
    private_key_pem=private_pem,
    signer_id="openEAGO-demo-signer-v1",
)
sig = signed.manifest_signature
print(f"    algorithm : {sig.algorithm}")
print(f"    signer    : {sig.signer}")
print(f"    timestamp : {sig.timestamp}")
print(f"    value     : {sig.value[:40]}...")

# ---------------------------------------------------------------------------
# 5. Print full manifest JSON
# ---------------------------------------------------------------------------
print("\n[5] Full signed manifest (JSON):")
print("-" * 64)
print(json.dumps(signed.to_dict(), indent=2))
print("-" * 64)

# ---------------------------------------------------------------------------
# 6. Verify — all checks should pass
# ---------------------------------------------------------------------------
print("\n[6] Verifying manifest ...")
result = verify_manifest(signed, public_pem)
print(f"    valid  : {result.valid}")
print(f"    checks : {len(result.checks)}")
for c in result.checks:
    print(f"      [PASS] {c}")
if result.failures:
    for f in result.failures:
        print(f"      [FAIL] {f}")

assert result.valid, f"Verification failed unexpectedly: {result.failures}"
print("    All checks passed.")

# ---------------------------------------------------------------------------
# 7. Tamper test — mutate trace_root, verify should fail
# ---------------------------------------------------------------------------
print("\n[7] Tamper test: mutating trace_root ...")
tampered = signed.model_copy(update={"trace_root": "TAMPERED-trace-root-000000"})
tamper_result = verify_manifest(tampered, public_pem)
print(f"    valid  : {tamper_result.valid}")
for f in tamper_result.failures:
    print(f"    [FAIL] {f}")

assert not tamper_result.valid, "Tamper test should have failed verification!"
print("    Tamper detected correctly.")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("\n" + "=" * 64)
print("All assertions passed.")
print(f"  Invocation : {signed.invocation_id}")
print(f"  Algorithm  : {sig.algorithm}")
print(f"  Signer     : {sig.signer}")
print(f"  Sources    : runtime, weights, rag ({len(rag_src.chunks)} chunks), prompt, {len(citations_src.citations)} citations")
print(f"  Canonical  : {len(signed.canonical_bytes())} bytes signed")
print(f"  Sig length : {len(sig.value)} chars (base64url)")
print(f"  Tamper     : detected via signature mismatch")
print("=" * 64)
