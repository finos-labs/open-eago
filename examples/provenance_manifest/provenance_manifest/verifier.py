"""Full manifest verification and artifact re-hash stubs.

VerificationResult accumulates per-check outcomes so callers can surface
structured audit evidence rather than a single boolean.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from .models import ProvenanceManifest
from .signer import verify_signature

logger = logging.getLogger(__name__)


@dataclass
class VerificationResult:
    valid: bool
    checks: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


def rehash_artifact(locator: str, expected_hash: str) -> bool:
    """Stub: log the would-be verification and return True.

    In production this would fetch *locator* from the registry, compute its
    SHA-256, and compare against *expected_hash*.
    """
    logger.info("rehash_artifact: would verify %s == %s", locator, expected_hash)
    return True


def verify_manifest(
    manifest: ProvenanceManifest,
    public_key_pem: str,
) -> VerificationResult:
    """Run all verification checks and return a structured result."""
    checks: list[str] = []
    failures: list[str] = []

    # --- Required fields ---
    if manifest.invocation_id:
        checks.append("invocation_id present")
    else:
        failures.append("invocation_id missing")

    if manifest.trace_root:
        checks.append("trace_root present")
    else:
        failures.append("trace_root missing")

    # --- Cryptographic signature ---
    if manifest.manifest_signature is None:
        failures.append("manifest_signature absent")
    else:
        try:
            ok = verify_signature(manifest, public_key_pem)
        except Exception as exc:
            ok = False
            failures.append(f"signature verification error: {exc}")

        if ok:
            checks.append(f"signature valid ({manifest.manifest_signature.algorithm})")
        else:
            failures.append("signature INVALID — manifest may have been tampered with")

    # --- Source artifact stubs ---
    sources = manifest.sources
    if sources.model_runtime is not None:
        if rehash_artifact(sources.model_runtime.locator, ""):
            checks.append(f"model_runtime verifiable: {sources.model_runtime.locator}")

    if sources.model_weights is not None:
        if rehash_artifact(sources.model_weights.locator, sources.model_weights.hash):
            checks.append(
                f"model_weights verifiable: {sources.model_weights.locator} "
                f"@ {sources.model_weights.commit}"
            )

    if sources.rag is not None:
        if rehash_artifact(
            sources.rag.index_snapshot.locator,
            sources.rag.index_snapshot.hash,
        ):
            checks.append(
                f"rag_index verifiable: {sources.rag.index_snapshot.locator} "
                f"({len(sources.rag.chunks)} chunks)"
            )

    if sources.training_data is not None:
        if rehash_artifact(sources.training_data.locator, sources.training_data.hash):
            checks.append(f"training_data verifiable: {sources.training_data.locator}")

    if sources.vector_index is not None:
        if rehash_artifact(sources.vector_index.locator, sources.vector_index.hash):
            checks.append(
                f"vector_index verifiable: {sources.vector_index.locator} "
                f"snapshot={sources.vector_index.snapshot_ts}"
            )

    if sources.prompt_template is not None:
        if rehash_artifact("prompt-registry", sources.prompt_template.hash):
            checks.append(
                f"prompt_template verifiable: {sources.prompt_template.name} "
                f"v{sources.prompt_template.version}"
            )

    if sources.grounding_citations is not None:
        n = len(sources.grounding_citations.citations)
        for citation in sources.grounding_citations.citations:
            rehash_artifact(citation.url, citation.content_hash)
        checks.append(f"grounding_citations recorded: {n} citation(s)")

    return VerificationResult(
        valid=len(failures) == 0,
        checks=checks,
        failures=failures,
    )
