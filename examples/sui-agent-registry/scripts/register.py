#!/usr/bin/env python3
"""
register.py — Register a test agent on the SUI Agentic Registry.

Uses `sui client call` (SUI CLI) to sign and submit the transaction with
the currently active wallet, then reads the result back via JSON-RPC.

Usage:
    python3 register.py [agentUri] [--agent-file path/to/agent.json]
    python3 register.py http://localhost:8080/agent.json --agent-file agent.json
"""

import json
import subprocess
import sys
from datetime import datetime, timezone

from sui_rpc import (
    PACKAGE_ID, IDENTITY_ID, CLOCK_ID, NETWORK,
    get_registry_info, get_agent_entry,
)

# ─── Config ───────────────────────────────────────────────────────────────────

args = [a for a in sys.argv[1:] if not a.startswith("--")]
agent_uri = args[0] if args else "http://localhost:8080/agent.json"

agent_file = None
if "--agent-file" in sys.argv:
    idx = sys.argv.index("--agent-file")
    if idx + 1 < len(sys.argv):
        agent_file = sys.argv[idx + 1]

# ─── 1. Submit registration transaction via SUI CLI ──────────────────────────

print("=" * 60)
print("SUI Agentic Registry — Agent Registration (Python)")
print("=" * 60)
print(f"Package  : {PACKAGE_ID}")
print(f"Registry : {IDENTITY_ID}")
print(f"Agent URI: {agent_uri}")
print()


def write_agent_file(path: str, global_id: str) -> None:
    """Update agentId and registrations in a local agent.json file."""
    with open(path, "r") as f:
        card = json.load(f)
    registry_ref = f"sui:{NETWORK}:{IDENTITY_ID}"
    card["agentId"] = global_id
    regs = card.get("registrations", [])
    reg_entry = next((r for r in regs if r.get("agentRegistry", "").startswith(f"sui:{NETWORK}:{IDENTITY_ID[:6]}")), None)
    if reg_entry:
        reg_entry["agentId"] = global_id
        reg_entry["agentRegistry"] = registry_ref
    else:
        regs.append({"agentId": global_id, "agentRegistry": registry_ref})
    card["registrations"] = regs
    with open(path, "w") as f:
        json.dump(card, f, indent=2)
        f.write("\n")


# ─── 1. Submit registration transaction via SUI CLI ──────────────────────────

print("► Submitting transaction (sui client call)...")

print()
print("► Submitting transaction (sui client call)...")



cmd = [
    "sui", "client", "call",
    "--package", PACKAGE_ID,
    "--module", "identity_registry",
    "--function", "register",
    "--args", IDENTITY_ID, agent_uri, CLOCK_ID,
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

# Find created objects
created = [o for o in result.get("objectChanges", []) if o.get("type") == "created"]

agent_cap_id   = None
agent_entry_id = None

for obj in created:
    obj_type = obj.get("objectType", "")
    obj_id   = obj.get("objectId", "")
    if "::identity_registry::AgentCap" in obj_type:
        agent_cap_id = obj_id
        print(f"✓ AgentCap created  : {obj_id}")
        print(f"  https://suiscan.xyz/testnet/object/{obj_id}")
    elif "::identity_registry::AgentEntry" in obj_type:
        agent_entry_id = obj_id
        print(f"✓ AgentEntry created: {obj_id}")
        print(f"  https://suiscan.xyz/testnet/object/{obj_id}")

# ─── 2. Read back the registered agent from chain ────────────────────────────

print()
print("► Reading registered agent from chain...")

try:
    info     = get_registry_info()
    counter  = info["counter"]
    agent_id = counter - 1  # last registered
    print(f"✓ Registry counter  : {counter} (agent ID = {agent_id})")

    agent = get_agent_entry(agent_id)

    print()
    print("─" * 60)
    print("Registered Agent")
    print("─" * 60)
    print(f"  globalId  : {agent['global_id']}")
    print(f"  agentId   : {agent['agent_id']}")
    print(f"  owner     : {agent['owner']}")
    print(f"  agentUri  : {agent['agent_uri']}")
    print(f"  active    : {agent['active']}")
    print(f"  createdAt : {agent['created_at']}")
    print()
    print("─" * 60)
    print("SuiScan links:")
    print(f"  Transaction : https://suiscan.xyz/testnet/tx/{tx_digest}")
    if agent_entry_id:
        print(f"  AgentEntry  : https://suiscan.xyz/testnet/object/{agent_entry_id}")
    if agent_cap_id:
        print(f"  AgentCap    : https://suiscan.xyz/testnet/object/{agent_cap_id}")
    print()
    print("Save your AgentCap — needed to update or deregister:")
    print(f"  AgentCap ID: {agent_cap_id}")
    print("─" * 60)

    # ─── 3. Write globalId back to local agent.json ────────────────────────────

    if agent_file:
        try:
            write_agent_file(agent_file, agent["global_id"])
            print(f"✓ Updated {agent_file} with agentId: {agent['global_id']}")
        except Exception as write_err:
            print(f"✗ Could not update {agent_file}: {write_err}")

except Exception as e:
    print(f"✗ Could not read agent entry: {e}")
