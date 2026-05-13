#!/usr/bin/env python3
"""
give_feedback.py — Submit reputation feedback for a registered agent.

The feedback value is a signed fixed-point number: magnitude × 10^(-decimals).
Positive feedback increases reputation; negative decreases it.
Self-feedback (owner rating their own agent) is rejected by the contract.

Usage:
    python3 give_feedback.py <AGENT_ID> <SCORE> [options]

Arguments:
    AGENT_ID   Numeric agent ID (e.g. 0)
    SCORE      Integer magnitude, 1–100 (always positive; use --negative for bad feedback)

Options:
    --negative          Mark this feedback as negative (bad experience)
    --decimals N        Decimal places for the score value (default: 0)
    --tag1 TAG          Primary category tag (e.g. "reliability", "quality")
    --tag2 TAG          Secondary tag (optional)
    --endpoint URL      Service endpoint this feedback relates to (optional)
    --feedback-uri URL  URI pointing to extended off-chain feedback JSON (optional)

Examples:
    # Positive: score +10 with tag "quality"
    python3 give_feedback.py 0 10 --tag1 quality

    # Negative: score -5 for unreliable behaviour
    python3 give_feedback.py 0 5 --negative --tag1 reliability --tag2 downtime

    # Precise score: +7.5 (magnitude=75, decimals=1)
    python3 give_feedback.py 0 75 --decimals 1 --tag1 quality
"""

import argparse
import json
import subprocess
import sys

from sui_rpc import (
    PACKAGE_ID, IDENTITY_ID, REPUTATION_ID, CLOCK_ID,
    get_agent_entry, get_reputation_events,
)

# ─── Args ─────────────────────────────────────────────────────────────────────

parser = argparse.ArgumentParser(description="Submit feedback for a SUI registry agent.")
parser.add_argument("agent_id",    type=int, help="Numeric agent ID")
parser.add_argument("score",       type=int, help="Score magnitude (1–100)")
parser.add_argument("--negative",  action="store_true", help="Mark as negative feedback")
parser.add_argument("--decimals",  type=int, default=0, help="Decimal places (default: 0)")
parser.add_argument("--tag1",      default="", help="Primary tag")
parser.add_argument("--tag2",      default="", help="Secondary tag")
parser.add_argument("--endpoint",  default="", help="Service endpoint URL")
parser.add_argument("--feedback-uri", default="", help="Off-chain feedback URI")
args = parser.parse_args()

if args.score < 1 or args.score > 100:
    print("Error: score must be between 1 and 100")
    sys.exit(1)

if args.decimals < 0 or args.decimals > 18:
    print("Error: decimals must be between 0 and 18")
    sys.exit(1)

# ─── Show agent info ──────────────────────────────────────────────────────────

print("=" * 60)
print("SUI Agentic Registry — Give Feedback")
print("=" * 60)

try:
    agent = get_agent_entry(args.agent_id)
except RuntimeError as e:
    print(f"✗ Agent {args.agent_id} not found: {e}")
    sys.exit(1)

direction = "NEGATIVE ▼" if args.negative else "POSITIVE ▲"
print(f"  Agent     : {agent['global_id']}")
print(f"  URI       : {agent['agent_uri']}")
print(f"  Score     : {direction}  magnitude={args.score}  decimals={args.decimals}")
if args.tag1:
    print(f"  Tag1      : {args.tag1}")
if args.tag2:
    print(f"  Tag2      : {args.tag2}")
if args.endpoint:
    print(f"  Endpoint  : {args.endpoint}")
print()

# ─── Submit transaction ───────────────────────────────────────────────────────

print("► Submitting transaction (sui client call)...")

# feedback_hash: empty vector<u8> — pass as hex string
feedback_hash = "0x"

cmd = [
    "sui", "client", "call",
    "--package", PACKAGE_ID,
    "--module", "reputation_registry",
    "--function", "give_feedback",
    "--args",
        REPUTATION_ID,
        IDENTITY_ID,
        str(args.agent_id),
        str(args.negative).lower(),        # bool: "true" / "false"
        str(args.score),                   # u128 magnitude
        str(args.decimals),                # u8 decimals
        args.tag1,
        args.tag2,
        args.endpoint,
        args.feedback_uri,
        feedback_hash,                     # vector<u8> empty
        CLOCK_ID,
    "--json",
]

try:
    raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
    result = json.loads(raw)
except subprocess.CalledProcessError as e:
    print(f"✗ Transaction failed (exit {e.returncode})")
    print("  Hint: self-feedback (rating your own agent) is rejected by the contract.")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"✗ Could not parse CLI output: {e}")
    sys.exit(1)

tx = result.get("digest", "unknown")
print(f"✓ Transaction submitted: {tx}")
print(f"  https://suiscan.xyz/testnet/tx/{tx}")

# ─── Show updated reputation summary ─────────────────────────────────────────

print()
print("► Updated reputation summary...")
rep = get_reputation_events(args.agent_id)
net = rep["net_score"]
sign = "+" if net >= 0 else ""
print(f"  Total feedback : {rep['count']}")
print(f"  Positive sum   : +{rep['positive_sum']}")
print(f"  Negative sum   : -{rep['negative_sum']}")
print(f"  Net score      : {sign}{net}")
