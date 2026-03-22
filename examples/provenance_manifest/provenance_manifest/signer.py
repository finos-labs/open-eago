"""ECDSA P-256 sign and verify for ProvenanceManifest.

Uses the `cryptography` package (no blockchain or external service deps).
Signatures are DER-encoded and stored as base64url strings in
ManifestSignature.value.
"""

from __future__ import annotations

import base64
from datetime import datetime, timezone

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from .models import ManifestSignature, ProvenanceManifest

ALGORITHM = "ECDSA-P256-SHA256"


def generate_key_pair() -> tuple[str, str]:
    """Generate an ECDSA P-256 key pair.

    Returns:
        (private_key_pem, public_key_pem) as UTF-8 strings.
    """
    private_key = ec.generate_private_key(ec.SECP256R1())
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def sign_manifest(
    manifest: ProvenanceManifest,
    private_key_pem: str,
    signer_id: str,
) -> ProvenanceManifest:
    """Sign *manifest* and return a new manifest with manifest_signature set.

    The canonical payload (manifest without manifest_signature) is hashed
    with SHA-256 and signed with ECDSA P-256.  The DER-encoded signature is
    stored base64url-encoded (no padding) in ManifestSignature.value.
    """
    payload = manifest.canonical_bytes()

    private_key = serialization.load_pem_private_key(
        private_key_pem.encode(), password=None
    )
    # cryptography signs with SHA-256 internally via ECDSA
    der_sig = private_key.sign(payload, ec.ECDSA(hashes.SHA256()))
    sig_b64 = base64.urlsafe_b64encode(der_sig).rstrip(b"=").decode()

    signed = manifest.model_copy(
        update={
            "manifest_signature": ManifestSignature(
                algorithm=ALGORITHM,
                signer=signer_id,
                value=sig_b64,
                timestamp=datetime.now(timezone.utc).isoformat(),
            )
        }
    )
    return signed


def verify_signature(manifest: ProvenanceManifest, public_key_pem: str) -> bool:
    """Return True if manifest_signature is a valid ECDSA P-256 signature.

    Raises ValueError if manifest has no signature.
    """
    if manifest.manifest_signature is None:
        raise ValueError("Manifest has no signature to verify.")

    payload = manifest.canonical_bytes()
    sig_value = manifest.manifest_signature.value

    # Restore base64url padding
    padding = 4 - len(sig_value) % 4
    if padding != 4:
        sig_value += "=" * padding
    der_sig = base64.urlsafe_b64decode(sig_value)

    public_key = serialization.load_pem_public_key(public_key_pem.encode())
    try:
        public_key.verify(der_sig, payload, ec.ECDSA(hashes.SHA256()))
        return True
    except Exception:
        return False
