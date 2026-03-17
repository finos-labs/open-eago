from shared.prompt_hash import canonical_hash


def test_canonical_hash_is_32_bytes():
    msgs = [{"role": "system", "content": "You are an AML officer.\n\nClient: {client_name}"}]
    h = canonical_hash(msgs)
    assert isinstance(h, bytes) and len(h) == 32


def test_canonical_hash_deterministic():
    msgs = [{"role": "system", "content": "test"}]
    assert canonical_hash(msgs) == canonical_hash(msgs)


def test_canonical_hash_matches_json_stringify_equivalent():
    # JSON.stringify([{"role":"system","content":"hello"}]) produces
    # '[{"role":"system","content":"hello"}]' (no spaces)
    import json
    from web3 import Web3
    msgs = [{"role": "system", "content": "hello"}]
    canonical = json.dumps(msgs, separators=(",", ":"), ensure_ascii=False)
    expected = bytes(Web3.keccak(text=canonical))
    assert canonical_hash(msgs) == expected


def test_canonical_hash_differs_for_different_messages():
    a = [{"role": "system", "content": "one"}]
    b = [{"role": "system", "content": "two"}]
    assert canonical_hash(a) != canonical_hash(b)
