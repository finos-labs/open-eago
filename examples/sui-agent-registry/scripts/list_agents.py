#!/usr/bin/env python3
"""
list_agents.py — List all registered agents in the SUI Agentic Registry.

Paginates through the ObjectTable dynamic fields and prints each agent.

Usage:
    python3 list_agents.py
    python3 list_agents.py --json       # output raw JSON
"""

import json
import sys

from sui_rpc import (
    IDENTITY_ID, NETWORK,
    get_registry_info, get_dynamic_fields, get_object,
)

output_json = "--json" in sys.argv

print("=" * 60)
print(f"SUI Agentic Registry — All Agents ({NETWORK})")
print("=" * 60)

# ─── Registry info ────────────────────────────────────────────────────────────

info = get_registry_info()
total = info["counter"]
table_id = info["table_id"]

print(f"Total registered agents: {total}")
print(f"Registry: https://suiscan.xyz/testnet/object/{IDENTITY_ID}")
print()

if total == 0:
    print("No agents registered yet.")
    sys.exit(0)

# ─── Paginate dynamic fields ──────────────────────────────────────────────────
# Each dynamic field descriptor gives us the AgentEntry object ID.
# We then fetch each entry individually for its fields.

agents = []
cursor = None

while True:
    page = get_dynamic_fields(table_id, cursor=cursor, limit=50)
    for field in page.get("data", []):
        entry_obj_id = field.get("objectId")
        if not entry_obj_id:
            continue
        try:
            obj = get_object(entry_obj_id)
            ef  = obj["content"]["fields"]
            agents.append({
                "agent_id":  int(ef["agent_id"]),
                "global_id": f"sui:{NETWORK}:{IDENTITY_ID}:{ef['agent_id']}",
                "owner":     ef["owner"],
                "agent_uri": ef["agent_uri"],
                "active":    ef["active"],
            })
        except Exception as e:
            print(f"  Warning: could not fetch entry {entry_obj_id}: {e}")

    if not page.get("hasNextPage"):
        break
    cursor = page.get("nextCursor")

# Sort by agent_id
agents.sort(key=lambda a: a["agent_id"])

# ─── Output ───────────────────────────────────────────────────────────────────

if output_json:
    print(json.dumps(agents, indent=2))
else:
    for a in agents:
        status = "active  " if a["active"] else "inactive"
        print(f"  [{a['agent_id']:>4}] {status}  {a['agent_uri']}")
        print(f"         globalId : {a['global_id']}")
        print(f"         owner    : {a['owner']}")
        print(f"         suiscan  : https://suiscan.xyz/testnet/account/{a['owner']}")
        print()

print(f"Total: {len(agents)} agent(s)")
