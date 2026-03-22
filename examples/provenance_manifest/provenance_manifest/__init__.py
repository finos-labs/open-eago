"""OpenEAGO Provenance Manifest — public API."""

from .collector import (
    build_manifest,
    collect_grounding_citations,
    collect_model_runtime,
    collect_model_weights,
    collect_prompt_template,
    collect_rag_chunks,
    hash_content,
)
from .models import (
    DatasetSource,
    GroundingCitation,
    GroundingCitationsSource,
    ManifestSignature,
    ManifestSources,
    ModelRuntimeSource,
    ModelWeightsSource,
    PromptTemplateSource,
    ProvenanceManifest,
    RagChunk,
    RagIndexSnapshot,
    RagSource,
    SBOMRef,
    SignatureRef,
    VectorIndexSource,
)
from .signer import generate_key_pair, sign_manifest, verify_signature
from .verifier import VerificationResult, rehash_artifact, verify_manifest

__all__ = [
    # models
    "GroundingCitation",
    "GroundingCitationsSource",
    "SBOMRef",
    "SignatureRef",
    "ModelRuntimeSource",
    "ModelWeightsSource",
    "RagChunk",
    "RagIndexSnapshot",
    "RagSource",
    "DatasetSource",
    "VectorIndexSource",
    "PromptTemplateSource",
    "ManifestSources",
    "ManifestSignature",
    "ProvenanceManifest",
    # collector
    "hash_content",
    "collect_model_runtime",
    "collect_model_weights",
    "collect_rag_chunks",
    "collect_prompt_template",
    "collect_grounding_citations",
    "build_manifest",
    # signer
    "generate_key_pair",
    "sign_manifest",
    "verify_signature",
    # verifier
    "VerificationResult",
    "rehash_artifact",
    "verify_manifest",
]
