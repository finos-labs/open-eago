#!/usr/bin/env python3
"""
health_check.py — Check availability and reputation of registered agents.

For each agent checked, this script:
  1. Fetches the on-chain AgentEntry (active status, URI)
  2. HTTP-probes the agentUri (is the agent actually reachable?)
  3. Computes the net reputation score from on-chain events
  4. Flags agents that are UNAVAILABLE or have LOW REPUTATION
  5. Optionally deactivates flagged agents if you own their AgentCap

Exit codes:
    0  All agents healthy
    1  One or more agents flagged (unavailable or low reputation)

Usage:
    # Check a single agent
    python3 health_check.py --agent-id 0

    # Check all registered agents
    python3 health_check.py --all

    # Deactivate flagged agents automatically (must own AgentCap)
    python3 health_check.py --agent-id 0 --deactivate --agent-cap 0xbd215ec4...

    # Change thresholds
    python3 health_check.py --all --rep-threshold -10 --timeout 10

    # Output JSON report
    python3 health_check.py --all --json
"""

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone

from sui_rpc import (
    PACKAGE_ID, IDENTITY_ID, CLOCK_ID,
    get_registry_info, get_agent_entry, get_reputation_events, check_agent_reachable,
)

# ─── Args ─────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Health-check agents in the SUI registry.")
group = parser.add_mutually_exclusive_group(required=True)
group.add_argument("--agent-id", type=int, help="Check a single agent by ID")
group.add_argument("--all",      action="store_true", help="Check all registered agents")

parser.add_argument("--deactivate",  action="store_true",
                    help="Deactivate flagged agents (requires --agent-cap for each)")
parser.add_argument("--agent-cap",   default="",
                    help="AgentCap ID for the agent (required with --deactivate)")
parser.add_argument("--rep-threshold", type=int, default=-5,
                    help="Net score below which agent is flagged as low-rep (default: -5)")
parser.add_argument("--timeout",     type=int, default=5,
                    help="HTTP probe timeout in seconds (default: 5)")
parser.add_argument("--json",        action="store_true", help="Output JSON report")
parser.add_argument("--yes", "-y",   action="store_true", help="Skip confirmation on deactivation")
args = parser.parse_args()

# ─── Determine which agents to check ─────────────────────────────────────────

info = get_registry_info()

if args.all:
    agent_ids = list(range(info["counter"]))
elif args.agent_id is not None:
    agent_ids = [args.agent_id]
else:
    agent_ids = []

if not agent_ids:
    print("No agents to check.")
    sys.exit(0)

# ─── Check each agent ─────────────────────────────────────────────────────────

def deactivate_agent(agent_cap_id: str, agent_id: int, skip_confirm: bool) -> bool:
    """Run deactivation transaction. Returns True on success."""
    if not skip_confirm:
        answer = input(f"  Deactivate agent {agent_id}? [y/N] ").strip().lower()
        if answer != "y":
            return False
    cmd = [
        "sui", "client", "call",
        "--package", PACKAGE_ID,
        "--module", "identity_registry",
        "--function", "deactivate",
        "--args", IDENTITY_ID, agent_cap_id, CLOCK_ID,
        "--json",
    ]
    try:
        raw    = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
        result = json.loads(raw)
        tx     = result.get("digest", "unknown")
        print(f"  ✓ Deactivated — tx: {tx}")
        print(f"    https://suiscan.xyz/testnet/tx/{tx}")
        return True
    except Exception as e:
        print(f"  ✗ Deactivation failed: {e}")
        return False


report   = []
any_flag = False

if not args.json:
    print("=" * 70)
    print(f"SUI Agentic Registry — Health Check  ({len(agent_ids)} agent(s))")
    print("=" * 70)
    print(f"  Rep threshold : net score < {args.rep_threshold}")
    print(f"  HTTP timeout  : {args.timeout}s")
    print()

for aid in agent_ids:
    try:
        agent = get_agent_entry(aid)
    except RuntimeError as e:
        if not args.json:
            print(f"[{aid}] ✗ Could not fetch: {e}")
        continue

    uri          = agent["agent_uri"]
    reachable, reason = check_agent_reachable(uri, timeout=args.timeout)
    rep          = get_reputation_events(aid)
    net          = rep["net_score"]
    low_rep      = net < args.rep_threshold
    inactive     = not agent["active"]

    flags = []
    if inactive:
        flags.append("INACTIVE")
    if not reachable and not inactive:
        flags.append("UNREACHABLE")
        any_flag = True
    if low_rep and not inactive:
        flags.append(f"LOW_REP(net={net})")
        any_flag = True

    status = "OK" if not flags else " | ".join(flags)

    entry = {
        "agent_id":   aid,
        "global_id":  agent["global_id"],
        "agent_uri":  uri,
        "active":     agent["active"],
        "reachable":  reachable,
        "reach_reason": reason,
        "net_score":  net,
        "rep_count":  rep["count"],
        "flags":      flags,
        "status":     status,
    }
    report.append(entry)

    if not args.json:
        icon = "✓" if not flags or flags == ["INACTIVE"] else "✗"
        print(f"[{aid}] {icon} {status}")
        print(f"      URI       : {uri}")
        print(f"      Reachable : {reachable}  ({reason})")
        print(f"      Net score : {net}  ({rep['count']} feedback(s))")
        if agent["active"]:
            print(f"      SuiScan   : https://suiscan.xyz/testnet/account/{agent['owner']}")

        # Auto-deactivate if flagged and cap provided
        if flags and "INACTIVE" not in flags and args.deactivate:
            cap_id = args.agent_cap
            if not cap_id:
                print("      ⚠ --deactivate requires --agent-cap <CAP_ID>")
            else:
                print(f"      Flagged — attempting deactivation...")
                deactivate_agent(cap_id, aid, skip_confirm=args.yes)
        print()

# ─── JSON report output ───────────────────────────────────────────────────────

if args.json:
    print(json.dumps({
        "checked_at":    datetime.now(tz=timezone.utc).isoformat(),
        "total":         len(report),
        "flagged":       sum(1 for r in report if r["flags"] and r["flags"] != ["INACTIVE"]),
        "rep_threshold": args.rep_threshold,
        "agents":        report,
    }, indent=2))
else:
    flagged = [r for r in report if r["flags"] and r["flags"] != ["INACTIVE"]]
    print("─" * 70)
    print(f"Result: {len(report)} checked  |  {len(flagged)} flagged")
    print("─" * 70)

sys.exit(1 if any_flag else 0)
