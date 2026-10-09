# Copyright 2026 Sankalp Gilda
# SPDX-License-Identifier: Apache-2.0
"""Command line: emit envelopes for a run, or verify them against the run.

    python -m evidence_profile emit fixtures/run.json out/
    python -m evidence_profile verify fixtures/run.json out/
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import VerificationError, demo_key, emit_run, public_key_hex, verify_run


def _emit(run: list, out: Path) -> int:
    out.mkdir(parents=True, exist_ok=True)
    for message, envelope in zip(run, emit_run(run, demo_key())):
        (out / f"{message['message_id']}.dsse.json").write_text(json.dumps(envelope, indent=2) + "\n")
        print(f"signed {message['message_id']} ({message['phase']})")
    return 0


def _verify(run: list, out: Path) -> int:
    envelopes = [json.loads((out / f"{m['message_id']}.dsse.json").read_text()) for m in run]
    try:
        statements = verify_run(envelopes, run, {"demo": public_key_hex(demo_key())})
    except VerificationError as exc:
        print(f"FAIL {exc}")
        return 1
    for statement in statements:
        subject = statement["subject"][0]
        print(f"ok {subject['name']} sha256:{subject['digest']['sha256'][:16]}...")
    print(f"verified {len(statements)} steps, chain intact")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="evidence_profile")
    parser.add_argument("command", choices=["emit", "verify"])
    parser.add_argument("run", type=Path, help="JSON array of OpenEAGO messages")
    parser.add_argument("out", type=Path, help="directory of <message_id>.dsse.json envelopes")
    args = parser.parse_args(argv)
    run = json.loads(args.run.read_text())
    return (_emit if args.command == "emit" else _verify)(run, args.out)


if __name__ == "__main__":
    sys.exit(main())
