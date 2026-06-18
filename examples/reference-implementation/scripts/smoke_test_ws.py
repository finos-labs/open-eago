#!/usr/bin/env python3
"""Smoke test: connect to the orchestrator's global WebSocket feed, submit the
'approved' scenario over REST, and confirm phase-completed events stream in
live (not via polling) before the REST call's own follow-up GET would see them.
"""
import asyncio
import json
import sys

import httpx
import websockets

ORCH = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000/ws/feed"


async def main() -> int:
    async with websockets.connect(WS) as ws:
        async with httpx.AsyncClient() as client:
            resp = await client.post(f"{ORCH}/api/v1/executions", json={"scenario": "approved"})
            resp.raise_for_status()
            execution_id = resp.json()["execution_id"]
            print(f"submitted {execution_id}, watching {WS} for its events...")

        seen_phases = []
        try:
            while len(seen_phases) < 6:
                raw = await asyncio.wait_for(ws.recv(), timeout=10)
                event = json.loads(raw)
                if event.get("execution_id") != execution_id:
                    continue
                if event.get("event_type") == "phase_completed":
                    seen_phases.append(event["phase"])
                    print(f"  [ws] live event: phase={event['phase']} conformant={event['data']['conformant']}")
        except asyncio.TimeoutError:
            print(f"FAILED: timed out waiting for events, only saw {seen_phases}", file=sys.stderr)
            return 1

    expected = [
        "contract_management", "planning_negotiation", "validation_compliance",
        "execution_resilience", "context_state_management", "communication_delivery",
    ]
    if seen_phases != expected:
        print(f"FAILED: phase order mismatch.\n  got:      {seen_phases}\n  expected: {expected}", file=sys.stderr)
        return 1

    print("\nWEBSOCKET SMOKE TEST PASSED: all 6 phase-completed events received live over /ws/feed.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
