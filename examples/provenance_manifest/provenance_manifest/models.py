"""Pydantic v2 models for OpenEAGO Provenance Manifest.

Mirrors the JSON structure from the provenance manifest proposal (section 4.4).
All source fields are Optional so partial manifests are valid.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import BaseModel, Field


class SBOMRef(BaseModel):
    format: str  # e.g. "cyclonedx-json", "spdx-json"
    hash: str    # sha256:<hex>


class SignatureRef(BaseModel):
    type: str         # e.g. "cosign", "sigstore"
    bundle_url: str   # URL to the signature bundle


class ModelRuntimeSource(BaseModel):
    locator: str           # OCI image ref, e.g. "ghcr.io/org/agent:sha256-..."
    sbom: Optional[SBOMRef] = None


class ModelWeightsSource(BaseModel):
    locator: str           # HuggingFace repo or S3 URI
    commit: str            # git commit SHA or model version tag
    hash: str              # sha256:<hex> of weights artifact
    signature: Optional[SignatureRef] = None


class RagChunk(BaseModel):
    source_doc_id: str
    chunk_hash: str        # sha256:<hex>
    retrieval_score: float


class RagIndexSnapshot(BaseModel):
    locator: str           # S3 URI, ANN index path
    hash: str              # sha256:<hex> of serialised index


class RagSource(BaseModel):
    index_snapshot: RagIndexSnapshot
    chunks: list[RagChunk] = Field(default_factory=list)


class DatasetSource(BaseModel):
    locator: str           # Dataset registry URI
    hash: str              # sha256:<hex> of canonical archive
    merkle_root: Optional[str] = None  # Merkle root if dataset is chunked


class VectorIndexSource(BaseModel):
    locator: str           # Vector DB URI / snapshot path
    hash: str              # sha256:<hex>
    snapshot_ts: str       # ISO-8601 timestamp of snapshot


class PromptTemplateSource(BaseModel):
    name: str
    version: str
    hash: str              # sha256:<hex> of template content


class GroundingCitation(BaseModel):
    url: str               # Canonical URL of the cited source
    title: Optional[str] = None
    retrieved_at: str      # ISO-8601 timestamp of fetch
    content_hash: str      # sha256:<hex> of the fetched content at retrieval time
    provider: Optional[str] = None  # e.g. "google-search", "bing", "perplexity"


class GroundingCitationsSource(BaseModel):
    citations: list[GroundingCitation] = Field(default_factory=list)


class ManifestSources(BaseModel):
    model_runtime: Optional[ModelRuntimeSource] = None
    model_weights: Optional[ModelWeightsSource] = None
    rag: Optional[RagSource] = None
    training_data: Optional[DatasetSource] = None
    vector_index: Optional[VectorIndexSource] = None
    prompt_template: Optional[PromptTemplateSource] = None
    grounding_citations: Optional[GroundingCitationsSource] = None


class ManifestSignature(BaseModel):
    algorithm: str   # e.g. "ECDSA-P256-SHA256"
    signer: str      # identifier of the signing key / service
    value: str       # base64url-encoded DER signature (excluded from signed payload)
    timestamp: str   # ISO-8601 signing time


class ProvenanceManifest(BaseModel):
    invocation_id: str
    trace_root: str
    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    sources: ManifestSources = Field(default_factory=ManifestSources)
    manifest_signature: Optional[ManifestSignature] = None

    def canonical_bytes(self) -> bytes:
        """Deterministic JSON (sorted keys, no whitespace) for signing.

        The manifest_signature field is excluded so that the signed payload
        does not depend on the signature value itself.
        """
        d = self.to_dict()
        d.pop("manifest_signature", None)
        return json.dumps(d, sort_keys=True, separators=(",", ":")).encode()

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
