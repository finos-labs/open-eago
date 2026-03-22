"""Artifact collection helpers for building ProvenanceManifest source fields.

In production these functions would call real registries, content-addressable
stores, and index snapshotting APIs.  Here they accept pre-known bytes/digests
and compute hashes locally, making the module usable without external I/O.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from .models import (
    GroundingCitation,
    GroundingCitationsSource,
    ManifestSources,
    ModelRuntimeSource,
    ModelWeightsSource,
    PromptTemplateSource,
    ProvenanceManifest,
    RagChunk,
    RagIndexSnapshot,
    RagSource,
    SBOMRef,
)


def hash_content(data: bytes) -> str:
    """Return 'sha256:<hex>' digest of *data*."""
    return "sha256:" + hashlib.sha256(data).hexdigest()


def collect_model_runtime(
    image_ref: str,
    sbom_data: bytes | None = None,
) -> ModelRuntimeSource:
    sbom = None
    if sbom_data is not None:
        sbom = SBOMRef(format="cyclonedx-json", hash=hash_content(sbom_data))
    return ModelRuntimeSource(locator=image_ref, sbom=sbom)


def collect_model_weights(
    locator: str,
    commit: str,
    content_bytes: bytes,
) -> ModelWeightsSource:
    return ModelWeightsSource(
        locator=locator,
        commit=commit,
        hash=hash_content(content_bytes),
    )


def collect_rag_chunks(
    chunks: list[dict[str, Any]],
    index_locator: str,
    index_bytes: bytes,
) -> RagSource:
    """Build a RagSource from a list of chunk dicts.

    Each dict must contain: source_doc_id (str), content (bytes|str),
    retrieval_score (float).
    """
    rag_chunks = []
    for c in chunks:
        content = c["content"]
        if isinstance(content, str):
            content = content.encode()
        rag_chunks.append(
            RagChunk(
                source_doc_id=c["source_doc_id"],
                chunk_hash=hash_content(content),
                retrieval_score=float(c["retrieval_score"]),
            )
        )
    return RagSource(
        index_snapshot=RagIndexSnapshot(
            locator=index_locator,
            hash=hash_content(index_bytes),
        ),
        chunks=rag_chunks,
    )


def collect_grounding_citations(
    citations: list[dict[str, Any]],
) -> GroundingCitationsSource:
    """Build a GroundingCitationsSource from a list of citation dicts.

    Each dict must contain: url (str), content (bytes|str), retrieved_at (str).
    Optional keys: title (str), provider (str).
    """
    result = []
    for c in citations:
        content = c["content"]
        if isinstance(content, str):
            content = content.encode()
        result.append(
            GroundingCitation(
                url=c["url"],
                title=c.get("title"),
                retrieved_at=c["retrieved_at"],
                content_hash=hash_content(content),
                provider=c.get("provider"),
            )
        )
    return GroundingCitationsSource(citations=result)


def collect_prompt_template(name: str, version: str, content: str) -> PromptTemplateSource:
    return PromptTemplateSource(
        name=name,
        version=version,
        hash=hash_content(content.encode()),
    )


def build_manifest(
    invocation_id: str,
    trace_root: str,
    sources: ManifestSources,
) -> ProvenanceManifest:
    return ProvenanceManifest(
        invocation_id=invocation_id,
        trace_root=trace_root,
        sources=sources,
    )
