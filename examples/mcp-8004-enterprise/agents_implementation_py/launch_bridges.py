"""
launch_bridges.py — Launch all Python oracle bridges as subprocesses.
Python counterpart to launch-bridges.js.

Pass the same flags as the Node.js version:
    python launch_bridges.py \
        --rpc                 http://127.0.0.1:8545 \
        --privkey             0x<YOUR_KEY> \
        --onboarding-registry 0x... \
        --aml-contract        0x... \
        --credit-contract     0x... \
        --legal-contract      0x... \
        --setup-contract      0x... \
        [--identity-registry  0x...] \
        [--flow-auth          0x...] \
        [--reputation-gate    0x...] \
        [--autonomy-bounds    0x...] \
        [--action-permit      0x...] \
        [--aml-agent-id       0]     \
        [--credit-agent-id    1]     \
        [--legal-agent-id     2]     \
        [--entity-agent-id    4]     \
        [--account-agent-id   5]     \
        [--product-agent-id   6]     \
        [--hf-doc-agent-id    7]     \
        [--hf-credit-agent-id 8]     \
        [--hf-legal-agent-id  9]
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

# (module, extra_flags_fn)
# Each tuple maps to a Python bridge module and a function that returns
# the extra flags specific to that bridge (given the parsed args namespace).
BRIDGES = [
    (
        "bridges.aml_bridge",
        lambda a: ["--contract", a.aml_contract, "--agent-id", a.aml_agent_id],
    ),
    (
        "bridges.credit_risk_bridge",
        lambda a: ["--contract", a.credit_contract, "--agent-id", a.credit_agent_id],
    ),
    (
        "bridges.legal_bridge",
        lambda a: ["--contract", a.legal_contract, "--agent-id", a.legal_agent_id],
    ),
    (
        "bridges.client_setup_bridge",
        lambda a: [
            "--onboarding-registry", a.onboarding_registry,
            "--setup-contract",      _require(a.setup_contract, "--setup-contract"),
            "--entity-agent-id",     a.entity_agent_id,
            "--account-agent-id",    a.account_agent_id,
            "--product-agent-id",    a.product_agent_id,
        ],
    ),
    (
        "bridges.hf_document_bridge",
        lambda a: [
            "--aml-contract",    a.aml_contract,
            "--credit-contract", a.credit_contract,
            "--agent-id",        a.hf_doc_agent_id,
        ],
    ),
    (
        "bridges.hf_credit_negotiator_bridge",
        lambda a: ["--credit-contract", a.credit_contract, "--agent-id", a.hf_credit_agent_id],
    ),
    (
        "bridges.hf_legal_bridge",
        lambda a: ["--legal-contract", a.legal_contract, "--agent-id", a.hf_legal_agent_id],
    ),
    (
        "bridges.onboarding_orchestrator_bridge",
        lambda a: [
            "--onboarding-registry", a.onboarding_registry,
            "--aml-contract",        a.aml_contract,
            "--credit-contract",     a.credit_contract,
            "--legal-contract",      a.legal_contract,
        ],
    ),
]

# ── Common flags injected into every bridge process ───────────────────────────
COMMON_FLAGS = [
    ("--rpc",               "rpc"),
    ("--privkey",           "privkey"),
    ("--signer-type",       "signer_type"),
    ("--vault-url",         "vault_url"),
    ("--vault-address",     "vault_address"),
    ("--identity-registry", "identity_registry"),
    ("--flow-auth",         "flow_auth"),
    ("--reputation-gate",   "reputation_gate"),
    ("--autonomy-bounds",   "autonomy_bounds"),
    ("--action-permit",     "action_permit"),
]


def _require(val: str | None, flag: str) -> str:
    if val is None:
        raise ValueError(f"{flag} not provided")
    return val


def _build_common(args: argparse.Namespace) -> list[str]:
    result = []
    for flag, attr in COMMON_FLAGS:
        val = getattr(args, attr, None)
        if val:
            result.extend([flag, val])
    return result


def main() -> None:
    p = argparse.ArgumentParser(description="Launch all Python oracle bridges")
    p.add_argument("--rpc",               default="http://127.0.0.1:8545")
    p.add_argument("--privkey",           default=None)
    p.add_argument("--signer-type",       dest="signer_type", default="local")
    p.add_argument("--vault-url",         dest="vault_url",   default=None)
    p.add_argument("--vault-address",     dest="vault_address", default=None)
    p.add_argument("--onboarding-registry", dest="onboarding_registry", required=True)
    p.add_argument("--aml-contract",      dest="aml_contract",    required=True)
    p.add_argument("--credit-contract",   dest="credit_contract", required=True)
    p.add_argument("--legal-contract",    dest="legal_contract",  required=True)
    p.add_argument("--setup-contract",    dest="setup_contract",  default=None)
    p.add_argument("--identity-registry", dest="identity_registry", default=None)
    p.add_argument("--flow-auth",         dest="flow_auth",         default=None)
    p.add_argument("--reputation-gate",   dest="reputation_gate",   default=None)
    p.add_argument("--autonomy-bounds",   dest="autonomy_bounds",   default=None)
    p.add_argument("--action-permit",     dest="action_permit",     default=None)
    p.add_argument("--aml-agent-id",      dest="aml_agent_id",      default="0")
    p.add_argument("--credit-agent-id",   dest="credit_agent_id",   default="1")
    p.add_argument("--legal-agent-id",    dest="legal_agent_id",    default="2")
    p.add_argument("--entity-agent-id",   dest="entity_agent_id",   default="4")
    p.add_argument("--account-agent-id",  dest="account_agent_id",  default="5")
    p.add_argument("--product-agent-id",  dest="product_agent_id",  default="6")
    p.add_argument("--hf-doc-agent-id",   dest="hf_doc_agent_id",   default="7")
    p.add_argument("--hf-credit-agent-id",dest="hf_credit_agent_id",default="8")
    p.add_argument("--hf-legal-agent-id", dest="hf_legal_agent_id", default="9")
    args = p.parse_args()

    common = _build_common(args)
    procs: list[subprocess.Popen] = []

    for module, extra_fn in BRIDGES:
        try:
            extra = extra_fn(args)
        except Exception as exc:
            print(f"Skipping {module}: {exc}")
            continue
        # Filter out None values
        extra = [str(v) for v in extra if v is not None]
        cmd = [sys.executable, "-m", module] + common + extra
        print(f"Starting {module}…")
        proc = subprocess.Popen(cmd, cwd=HERE)
        procs.append(proc)

    print(f"\n{len(procs)} Python bridges started. Press Ctrl-C to stop all.\n")

    def _shutdown(sig, frame):
        print("\nShutting down all bridges…")
        for proc in procs:
            proc.terminate()
        for proc in procs:
            proc.wait()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    for proc in procs:
        proc.wait()


if __name__ == "__main__":
    main()
