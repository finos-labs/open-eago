#!/usr/bin/env python3
"""
reputation_summary.py — Show the full reputation summary for a registered agent.

Fetches all NewFeedback and FeedbackRevoked events from the chain and builds
a live score summary. Also shows per-tag breakdowns and individual records.

Usage:
    python3 reputation_summary.py <AGENT_ID>
    python3 reputation_summary.py 0
    python3 reputation_summary.py 0 --json
    python3 reputation_summary.py 0 --tag reliability
"""

import argparse
import json

from sui_rpc import get_agent_entry, get_reputation_events, IDENTITY_ID

# ─── Args ─────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Show reputation summary for an agent.")
parser.add_argument("agent_id", type=int, help="Numeric agent ID")
parser.add_argument("--json",   action="store_true", help="Output raw JSON")
parser.add_argument("--tag",    default="", help="Filter by tag1")
parser.add_argument("--all",    action="store_true", help="Show all individual records including revoked")
args = parser.parse_args()

# ─── Fetch data ───────────────────────────────────────────────────────────────

agent = get_agent_entry(args.agent_id)
rep   = get_reputation_events(args.agent_id)

# ─── JSON output ──────────────────────────────────────────────────────────────

if args.json:
    print(json.dumps({
        "agent": agent,
        "reputation": rep,
    }, indent=2))
    exit(0)

# ─── Human-readable output ────────────────────────────────────────────────────

print("=" * 60)
print(f"Reputation Summary — Agent {args.agent_id}")
print("=" * 60)
print(f"  globalId  : {agent['global_id']}")
print(f"  owner     : {agent['owner']}")
print(f"  agentUri  : {agent['agent_uri']}")
print(f"  active    : {agent['active']}")
print()

feedback = rep["feedback"]

# Apply tag filter
if args.tag:
    feedback = [f for f in feedback if f["tag1"] == args.tag or f["tag2"] == args.tag]
    filtered_pos = sum(f["magnitude"] for f in feedback if not f["negative"] and not f["revoked"])
    filtered_neg = sum(f["magnitude"] for f in feedback if f["negative"] and not f["revoked"])
    filtered_count = sum(1 for f in feedback if not f["revoked"])
    net = filtered_pos - filtered_neg
    sign = "+" if net >= 0 else ""
    print(f"  (filtered by tag: {args.tag})")
    print(f"  Count    : {filtered_count}")
    print(f"  Positive : +{filtered_pos}")
    print(f"  Negative : -{filtered_neg}")
    print(f"  Net score: {sign}{net}")
else:
    net  = rep["net_score"]
    sign = "+" if net >= 0 else ""
    print(f"  Total feedback : {rep['count']}")
    print(f"  Positive sum   : +{rep['positive_sum']}")
    print(f"  Negative sum   : -{rep['negative_sum']}")
    print(f"  Net score      : {sign}{net}")
    print()

    # Per-tag breakdown
    tags = {}
    for f in feedback:
        if f["revoked"]:
            continue
        for tag in [f["tag1"], f["tag2"]]:
            if not tag:
                continue
            if tag not in tags:
                tags[tag] = {"pos": 0, "neg": 0, "count": 0}
            tags[tag]["count"] += 1
            if f["negative"]:
                tags[tag]["neg"] += f["magnitude"]
            else:
                tags[tag]["pos"] += f["magnitude"]

    if tags:
        print("  Tag breakdown:")
        for tag, s in sorted(tags.items()):
            tag_net = s["pos"] - s["neg"]
            sign_t  = "+" if tag_net >= 0 else ""
            print(f"    {tag:<20} count={s['count']}  pos=+{s['pos']}  neg=-{s['neg']}  net={sign_t}{tag_net}")
        print()

# ─── Individual records ───────────────────────────────────────────────────────

visible = feedback if args.all else [f for f in feedback if not f["revoked"]]

if visible:
    print("─" * 60)
    print(f"{'#':<4} {'Client':<20} {'Score':<10} {'Tag1':<14} {'Tag2':<14} {'Revoked'}")
    print("─" * 60)
    for f in visible:
        direction = f"-{f['magnitude']}" if f["negative"] else f"+{f['magnitude']}"
        if f["decimals"]:
            direction += f"e-{f['decimals']}"
        client_short = f["client"][:18] + ".." if len(f["client"]) > 20 else f["client"]
        revoked_str  = "REVOKED" if f["revoked"] else ""
        print(f"{f['index']:<4} {client_short:<20} {direction:<10} {f['tag1']:<14} {f['tag2']:<14} {revoked_str}")
    print()

if not feedback:
    print("  No feedback recorded yet.")
