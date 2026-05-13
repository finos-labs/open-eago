#!/usr/bin/env python3
"""
read_agent.py — Read a registered agent from the SUI Agentic Registry.

Usage:
    python3 read_agent.py [agentId]     # default: 0
    python3 read_agent.py 0
"""

import json
import sys

from sui_rpc import IDENTITY_ID, NETWORK, get_registry_info, get_agent_entry, fetch_agent_card

agent_id = int(sys.argv[1]) if len(sys.argv) > 1 else 0

print("=" * 60)
print(f"Reading agent ID {agent_id} from {NETWORK}")
print("=" * 60)

# ─── Registry stats ───────────────────────────────────────────────────────────

info = get_registry_info()
print(f"Registry total agents : {info['counter']}")
print(f"IdentityRegistry ID   : {IDENTITY_ID}")
print(f"  https://suiscan.xyz/testnet/object/{IDENTITY_ID}")
print()

# ─── Agent entry ──────────────────────────────────────────────────────────────

try:
    agent = get_agent_entry(agent_id)
except RuntimeError as e:
    print(f"✗ Agent ID {agent_id} not found: {e}")
    sys.exit(1)

print("─" * 60)
print("Agent Entry")
print("─" * 60)
print(f"  globalId  : {agent['global_id']}")
print(f"  agentId   : {agent['agent_id']}")
print(f"  owner     : {agent['owner']}")
print(f"  agentUri  : {agent['agent_uri']}")
print(f"  active    : {agent['active']}")
print(f"  createdAt : {agent['created_at']}")
print(f"  updatedAt : {agent['updated_at']}")
print()
print(f"  SuiScan   : https://suiscan.xyz/testnet/account/{agent['owner']}")
print()

# ─── Fetch agent card from URI ────────────────────────────────────────────────

uri = agent["agent_uri"]
if uri.startswith("http"):
    print(f"► Fetching agent card from {uri} ...")
    card = fetch_agent_card(uri)
    if card:
        print()
        print("Agent Card (agent.json):")
        print(json.dumps(card, indent=2))
    else:
        print("  (could not fetch agent card)")
