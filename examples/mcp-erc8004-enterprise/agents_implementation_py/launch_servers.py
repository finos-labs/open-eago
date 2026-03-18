"""
launch_servers.py — Launch all Python MCP servers as subprocesses.
Python counterpart to launch-agents.js.

Each server is started in a separate process.
Ctrl-C terminates all servers.

Usage:
    python launch_servers.py [--smoke-test]

    --smoke-test  Use ports +100 (8110+) for parallel smoke testing
                  without conflicting with the Node.js servers.
"""

from __future__ import annotations

import argparse
import signal
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).parent

SERVER_MAP = [
    # (module, default_port, smoke_port)
    ("servers.aml_server",                   8010, 8110),
    ("servers.credit_risk_server",            8011, 8111),
    ("servers.legal_server",                  8012, 8112),
    ("servers.onboarding_orchestrator_server",8013, 8113),
    ("servers.client_setup_server",           8014, 8114),
    ("servers.hf_document_server",            8020, 8120),
    ("servers.hf_credit_negotiator_server",   8021, 8121),
    ("servers.hf_legal_server",               8022, 8122),
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch all Python MCP servers")
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="Use ports +100 (8110+) to avoid conflicting with Node.js servers",
    )
    args = parser.parse_args()

    procs: list[subprocess.Popen] = []
    port_idx = 2 if args.smoke_test else 1  # index into SERVER_MAP tuple

    for entry in SERVER_MAP:
        module = entry[0]
        port   = entry[port_idx]
        cmd = [sys.executable, "-m", module, str(port)]
        print(f"Starting {module} on port {port}…")
        proc = subprocess.Popen(cmd, cwd=HERE)
        procs.append(proc)

    print(f"\n{len(procs)} Python MCP servers started. Press Ctrl-C to stop all.\n")

    def _shutdown(sig, frame):
        print("\nShutting down all servers…")
        for p in procs:
            p.terminate()
        for p in procs:
            p.wait()
        sys.exit(0)

    signal.signal(signal.SIGINT,  _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    for p in procs:
        p.wait()


if __name__ == "__main__":
    main()
