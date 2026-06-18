#!/usr/bin/env bash
# Single readiness check for the whole stack: MongoDB, agent-registry, all 6
# phase agents, and the orchestrator. Run this after starting everything in
# README.md "Running it" and before opening the dashboard.
#
# Usage: ./scripts/check_environment.sh
# Exit code 0 = everything ready. Exit code 1 = something isn't up yet.

set -uo pipefail

FAIL=0
ok()   { printf "  [ok]   %s\n" "$1"; }
bad()  { printf "  [FAIL] %s\n" "$1"; FAIL=1; }

check_http() {
  local label="$1" url="$2"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null)
  if [ "$code" = "200" ]; then ok "$label ($url -> 200)"; else bad "$label ($url -> ${code:-no response})"; fi
}

echo "=== MongoDB ==="
if docker exec eago-refimpl-mongodb mongosh --quiet --eval "db.runCommand({ping:1})" \
    -u admin -p password --authenticationDatabase admin >/dev/null 2>&1; then
  ok "mongodb (eago-refimpl-mongodb container, ping)"
else
  bad "mongodb (eago-refimpl-mongodb container not reachable - did you run 'docker compose up -d' in db/?)"
fi

echo "=== Agent Registry ==="
check_http "registry health" "http://127.0.0.1:8443/health"
check_http "registry swagger UI" "http://127.0.0.1:8080/swagger-ui/"

echo "=== Phase Agents ==="
# Plain bash 3.2 (macOS default) has no associative arrays - use parallel lists.
AGENT_NAMES="contract planning validation execution context communication"
AGENT_PORTS="9001 9002 9003 9004 9005 9006"
i=1
for name in $AGENT_NAMES; do
  port=$(echo "$AGENT_PORTS" | cut -d' ' -f"$i")
  check_http "$name agent" "http://127.0.0.1:${port}/health"
  i=$((i + 1))
done

echo "=== Registry discovery (agents actually findable, not just registered) ==="
DISCOVERED=$(curl -s --max-time 3 -X POST http://127.0.0.1:8443/discover \
  -H 'Content-Type: application/json' -d '{}' 2>/dev/null | jq -r '.count // 0')
if [ "${DISCOVERED:-0}" -ge 6 ]; then
  ok "all 6 agents discoverable via /discover (count=$DISCOVERED)"
elif [ "${DISCOVERED:-0}" -gt 0 ]; then
  bad "only $DISCOVERED/6 agents discoverable yet - freshly started agents take ~90-100s to clear the registry's uptime floor, see README 'Known operational quirk'"
else
  bad "0 agents discoverable - registry unreachable or no agents registered"
fi

echo "=== Orchestrator ==="
ORCH_HEALTH=$(curl -s --max-time 3 http://127.0.0.1:8000/health 2>/dev/null)
if echo "$ORCH_HEALTH" | jq -e '.status == "healthy"' >/dev/null 2>&1; then
  ok "orchestrator health: $ORCH_HEALTH"
else
  bad "orchestrator not healthy: ${ORCH_HEALTH:-no response}"
fi

echo "=== Dashboard (dev server) ==="
check_http "dashboard" "http://localhost:5173/"

echo
if [ "$FAIL" -eq 0 ]; then
  echo "READY: all components up. Open http://localhost:5173"
else
  echo "NOT READY: see [FAIL] lines above."
fi
exit "$FAIL"
