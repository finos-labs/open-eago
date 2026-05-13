#!/usr/bin/env python3
"""
update_agent_uri.py — Update the agentUri of an already-registered agent.

Requires the AgentCap object ID (received at registration time).
Uses `sui client call` with the active wallet.

Usage:
    python3 update_agent_uri.py <AGENT_CAP_ID> <NEW_URI>
    python3 update_agent_uri.py 0xbd215ec4... https://myagent.example.com/agent.json
"""

import json
import subprocess
import sys

from sui_rpc import PACKAGE_ID, IDENTITY_ID, CLOCK_ID, get_agent_entry, get_registry_info

if len(sys.argv) < 3:
    print("Usage: python3 update_agent_uri.py <AGENT_CAP_ID> <NEW_URI>")
    sys.exit(1)

agent_cap_id = sys.argv[1]
new_uri      = sys.argv[2]

print("=" * 60)
print("SUI Agentic Registry — Update Agent URI")
print("=" * 60)
print(f"AgentCap : {agent_cap_id}")
print(f"New URI  : {new_uri}")
print()
print("► Submitting transaction (sui client call)...")

cmd = [
    "sui", "client", "call",
    "--package", PACKAGE_ID,
    "--module", "identity_registry",
    "--function", "set_agent_uri",
    "--args", IDENTITY_ID, agent_cap_id, new_uri, CLOCK_ID,
    "--json",
]

try:
    result_raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    result = json.loads(result_raw)
except subprocess.CalledProcessError as e:
    print(f"✗ Transaction failed (exit {e.returncode})")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"✗ Could not parse CLI output: {e}")
    sys.exit(1)

tx_digest = result.get("digest", "unknown")
print(f"✓ Transaction submitted: {tx_digest}")
print(f"  https://suiscan.xyz/testnet/tx/{tx_digest}")

# ─── Find the agent_id from the AgentCap's mutated/created list ──────────────

# The AgentCap carries agent_id — look it up from changed objects
agent_id = None
for obj in result.get("objectChanges", []):
    if "AgentCap" in obj.get("objectType", "") and obj.get("objectId") == agent_cap_id:
        # AgentCap itself doesn't expose agent_id in objectChanges; read from registry
        pass

# Read the registry to find which entry was updated
info = get_registry_info()
# Try each agent_id until we find the one owned by the current cap
# (The AgentEntry objectId is deterministic — find by new URI)
print()
print("► Verifying update on chain...")
for aid in range(info["counter"]):
    try:
        agent = get_agent_entry(aid)
        if agent["agent_uri"] == new_uri:
            agent_id = aid
            print(f"✓ Agent {aid} URI updated successfully")
            print(f"  globalId : {agent['global_id']}")
            print(f"  agentUri : {agent['agent_uri']}")
            print(f"  updatedAt: {agent['updated_at']}")
            break
    except Exception:
        continue

if agent_id is None:
    print("  (could not verify update — check the transaction on SuiScan)")
