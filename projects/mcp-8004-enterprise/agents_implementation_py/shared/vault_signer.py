"""
vault_signer.py — HSM / Vault signing shim for oracle bridges.
Port of vault-signer.js using web3.py Account abstraction.

Two backends:
  "local"  — wraps eth_account.Account (dev / CI)
  "vault"  — VaultSigner: delegates signing to an HTTP endpoint
             (HashiCorp Vault Transit, AWS KMS, Azure Key Vault, etc.)
             The private key never leaves the vault process.

Usage:
    from shared.vault_signer import create_signer, BaseSigner
    signer = create_signer(
        signer_type=os.getenv("SIGNER_TYPE", "local"),
        private_key=os.getenv("ORACLE_PRIVATE_KEY"),
        vault_url=os.getenv("VAULT_URL"),
        vault_address=os.getenv("ORACLE_ADDRESS"),
    )
    signed_tx = signer.sign_transaction(tx_dict)
    address   = signer.address
"""

from __future__ import annotations

import abc
from typing import Optional

import httpx
from eth_account import Account
from eth_account.datastructures import SignedTransaction


class BaseSigner(abc.ABC):
    """Minimal signer interface used by all bridges."""

    @property
    @abc.abstractmethod
    def address(self) -> str: ...

    @abc.abstractmethod
    def sign_transaction(self, tx: dict) -> SignedTransaction: ...

    @abc.abstractmethod
    def sign_message(self, message: bytes) -> bytes: ...


# ── Local signer (dev / CI) ───────────────────────────────────────────────────

class LocalSigner(BaseSigner):
    """Wraps eth_account.Account; private key held in process memory."""

    def __init__(self, private_key: str) -> None:
        self._account = Account.from_key(private_key)

    @property
    def address(self) -> str:
        return self._account.address

    def sign_transaction(self, tx: dict) -> SignedTransaction:
        return self._account.sign_transaction(tx)

    def sign_message(self, message: bytes) -> bytes:
        return self._account.sign_message(message).signature


# ── Vault signer (production) ─────────────────────────────────────────────────

class VaultSigner(BaseSigner):
    """
    Signer backed by an HTTP signing endpoint.

    Expected endpoint contract (POST ${vault_url}/sign):
      Request:  {"hash": "0x..."}           — hex-encoded 32-byte hash
      Response: {"signature": "0x..."}      — 65-byte ECDSA signature (r, s, v)
    """

    def __init__(self, vault_url: str, address: str) -> None:
        self._vault_url = vault_url.rstrip("/")
        self._address = address

    @property
    def address(self) -> str:
        return self._address

    def _remote_sign(self, hash_hex: str) -> str:
        resp = httpx.post(
            f"{self._vault_url}/sign",
            json={"hash": hash_hex},
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if "signature" not in data:
            raise ValueError("VaultSigner: response missing 'signature' field")
        return data["signature"]

    def sign_transaction(self, tx: dict) -> SignedTransaction:
        raise NotImplementedError(
            "VaultSigner.sign_transaction: full RLP reconstruction not yet implemented. "
            "Use web3.py middleware instead for production vault signing."
        )

    def sign_message(self, message: bytes) -> bytes:
        from eth_account.messages import encode_defunct
        from eth_utils import keccak

        signable = encode_defunct(primitive=message)
        msg_hash = "0x" + keccak(signable.body).hex()
        sig_hex = self._remote_sign(msg_hash)
        return bytes.fromhex(sig_hex.removeprefix("0x"))


# ── Factory ───────────────────────────────────────────────────────────────────

def create_signer(
    signer_type: str = "local",
    private_key: Optional[str] = None,
    vault_url: Optional[str] = None,
    vault_address: Optional[str] = None,
) -> BaseSigner:
    """
    Factory: returns the appropriate BaseSigner implementation.

    Args:
        signer_type:    "local" or "vault"
        private_key:    Required when signer_type="local"
        vault_url:      Required when signer_type="vault"
        vault_address:  Required when signer_type="vault"
    """
    if signer_type == "local":
        if not private_key:
            raise ValueError("create_signer: private_key required for signer_type='local'")
        return LocalSigner(private_key)

    if signer_type == "vault":
        if not vault_url:
            raise ValueError("create_signer: vault_url required for signer_type='vault'")
        if not vault_address:
            raise ValueError("create_signer: vault_address required for signer_type='vault'")
        return VaultSigner(vault_url, vault_address)

    raise ValueError(f"create_signer: unknown signer_type '{signer_type}'. Use 'local' or 'vault'.")
