from shared.vault_signer import create_signer, LocalSigner, VaultSigner

# Known test key (Hardhat account 0)
_TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
_EXPECTED_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


def test_local_signer_address():
    signer = create_signer("local", private_key=_TEST_KEY)
    assert signer.address.lower() == _EXPECTED_ADDR.lower()


def test_local_signer_sign_message_returns_65_bytes():
    signer = create_signer("local", private_key=_TEST_KEY)
    sig = signer.sign_message(b"hello world")
    assert isinstance(sig, bytes) and len(sig) == 65


def test_vault_signer_factory_requires_url():
    import pytest
    with pytest.raises(ValueError, match="vault_url"):
        create_signer("vault", vault_address="0x1234")


def test_unknown_signer_type_raises():
    import pytest
    with pytest.raises(ValueError, match="unknown signer_type"):
        create_signer("hsm")
