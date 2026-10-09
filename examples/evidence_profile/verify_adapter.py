#!/usr/bin/env python3
# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""Drive this example's DSSE verifier through the agent-evidence-vectors contract.

Invoked as ``verify_adapter.py <envelope.json>``. Exit 0 means valid, 1 means
invalid, and the last stdout line is one JSON object naming the verdict and the
reason codes. Trusted keys come from the JSON file named by
``EVIDENCE_PROFILE_KEYS`` (``{"label": "<ed25519 public key hex>"}``).
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from evidence_profile import VerificationError, open_envelope  # noqa: E402


def main() -> int:
    if len(sys.argv) != 2 or not os.getenv("EVIDENCE_PROFILE_KEYS"):
        print("usage: EVIDENCE_PROFILE_KEYS=keys.json verify_adapter.py <envelope>", file=sys.stderr)
        return 3
    keys = json.loads(Path(os.environ["EVIDENCE_PROFILE_KEYS"]).read_text())
    try:
        envelope = json.loads(Path(sys.argv[1]).read_bytes())
        open_envelope(envelope, keys)
    except VerificationError as exc:
        print(json.dumps({"verdict": "invalid", "codes": [exc.code]}))
        return 1
    except ValueError:
        print(json.dumps({"verdict": "invalid", "codes": ["envelope-malformed"]}))
        return 1
    print(json.dumps({"verdict": "valid", "codes": []}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
