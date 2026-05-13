#!/usr/bin/env python3
"""
deregister_agent.py — Deactivate a registered agent on the SUI Agentic Registry.

Deactivation sets agent.active = false on-chain. The AgentEntry and AgentCap
objects are NOT destroyed — the record is preserved for historical reference
and the agent cannot receive new feedback while inactive.

This is a one-way operation per the contract: there is no reactivate function.
The owner must hold the AgentCap to deactivate.

Usage:
    python3 deregister_agent.py <AGENT_CAP_ID>
    python3 deregister_agent.py 0xbd215ec4...

    # Skip confirmation prompt:
    python3 deregister_agent.py <AGENT_CAP_ID> --yes
"""

import argparse
import json
import subprocess
import sys

from sui_rpc import PACKAGE_ID, IDENTITY_ID, CLOCK_ID, get_agent_entry, get_registry_info

# ─── Args ─────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Deactivate a registered agent.")
parser.add_argument("agent_cap_id", help="AgentCap object ID (received at registration)")
parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation prompt")
args = parser.parse_args()

# ─── Find the agent_id for this cap ──────────────────────────────────────────

print("=" * 60)
print("SUI Agentic Registry — Deregister Agent")
print("=" * 60)
print(f"AgentCap: {args.agent_cap_id}")
print()
print("► Looking up agent from registry...")

info     = get_registry_info()
agent    = None
agent_id = None

for aid in range(info["counter"]):
    try:
        entry = get_agent_entry(aid)
        # Cross-check: fetch the AgentCap object to verify it matches this agent
        # We compare owner address; full verification happens on-chain via cap.registry_id
    except Exception:
        continue

# Fetch the AgentCap object directly to get its agent_id
from sui_rpc import get_object
try:
    cap_obj = get_object(args.agent_cap_id)
    cap_fields = cap_obj["content"]["fields"]
    agent_id   = int(cap_fields["agent_id"])
    agent      = get_agent_entry(agent_id)
except Exception as e:
    print(f"✗ Could not fetch AgentCap {args.agent_cap_id}: {e}")
    print("  Make sure the AgentCap object ID is correct and owned by your active wallet.")
    sys.exit(1)

print(f"✓ Found agent ID {agent_id}")
print()
print("─" * 60)
print(f"  globalId  : {agent['global_id']}")
print(f"  owner     : {agent['owner']}")
print(f"  agentUri  : {agent['agent_uri']}")
print(f"  active    : {agent['active']}")
print("─" * 60)
print()

if not agent["active"]:
    print("Agent is already inactive. Nothing to do.")
    sys.exit(0)

# ─── Confirmation ─────────────────────────────────────────────────────────────

if not args.yes:
    print("WARNING: Deactivation is permanent. The agent cannot be reactivated.")
    answer = input(f"Deactivate agent {agent_id} ({agent['agent_uri']})? [y/N] ").strip().lower()
    if answer != "y":
        print("Aborted.")
        sys.exit(0)

# ─── Submit transaction ───────────────────────────────────────────────────────

print()
print("► Submitting deactivation transaction...")

cmd = [
    "sui", "client", "call",
    "--package", PACKAGE_ID,
    "--module", "identity_registry",
    "--function", "deactivate",
    "--args",
        IDENTITY_ID,
        args.agent_cap_id,
        CLOCK_ID,
    "--json",
]

try:
    raw    = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    result = json.loads(raw)
except subprocess.CalledProcessError as e:
    print(f"✗ Transaction failed (exit {e.returncode})")
    print("  Make sure your active wallet owns this AgentCap.")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"✗ Could not parse CLI output: {e}")
    sys.exit(1)

tx = result.get("digest", "unknown")
print(f"✓ Transaction submitted: {tx}")
print(f"  https://suiscan.xyz/testnet/tx/{tx}")

# ─── Verify ───────────────────────────────────────────────────────────────────

print()
print("► Verifying on-chain...")
updated = get_agent_entry(agent_id)
status  = "inactive ✓" if not updated["active"] else "still active (check tx)"
print(f"  Agent {agent_id} status: {status}")
print(f"  updatedAt : {updated['updated_at']}")
print()
print(f"  SuiScan: https://suiscan.xyz/testnet/object/{args.agent_cap_id}")
