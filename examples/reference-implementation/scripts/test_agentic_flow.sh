#!/usr/bin/env bash
# Exercises the full OpenEAGO reference implementation agentic flow with a
# curated set of real HTTP calls: infra health, raw agent-to-agent MCP call,
# registry discovery, and all four orchestrator scenarios (approved, blocked,
# sla_breach, hitl_required - including the human approval step).
#
# Assumes the stack is already running (see README.md):
#   - MongoDB                         (docker compose, db/)
#   - agent-registry --allow-insecure :8443
#   - 6 phase agents                  :9001-9006
#   - orchestrator                    :8000
#
# Usage: ./scripts/test_agentic_flow.sh
# Requires: curl, jq

set -uo pipefail

REGISTRY=http://127.0.0.1:8443
AGENT_CONTRACT=http://127.0.0.1:9001
ORCH=http://127.0.0.1:8000

section() { printf "\n=== %s ===\n" "$1"; }

# --- helpers -----------------------------------------------------------

submit_scenario() {
  local scenario="$1"
  curl -s -X POST "$ORCH/api/v1/executions" \
    -H 'Content-Type: application/json' \
    -d "{\"scenario\": \"$scenario\"}" | jq -r '.execution_id'
}

submit_task_data() {
  curl -s -X POST "$ORCH/api/v1/executions" \
    -H 'Content-Type: application/json' \
    -d "$1" | jq -r '.execution_id'
}

# Polls GET /api/v1/executions/{id} until status is terminal or a timeout hits.
wait_for_status() {
  local execution_id="$1"
  local max_wait="${2:-15}"
  local waited=0
  local status=""
  while [ "$waited" -lt "$max_wait" ]; do
    status=$(curl -s "$ORCH/api/v1/executions/$execution_id" | jq -r '.status')
    case "$status" in
      completed|rejected|failed|awaiting_hitl) echo "$status"; return 0 ;;
    esac
    sleep 1
    waited=$((waited + 1))
  done
  echo "$status (timed out after ${max_wait}s)"
}

summarize() {
  local execution_id="$1"
  curl -s "$ORCH/api/v1/executions/$execution_id" | jq '{
    execution_id, scenario, status,
    phases: (.phases | keys),
    risk: (.phases.validation_compliance.document.risk_assessment // .validation_draft.risk_assessment
           | {tier: .risk_tier, score: .composite_risk_score, escalation: .escalation_outcome}),
    sla: .phases.execution_resilience.document.sla_compliance_status
           | {breach_state, overall_sla_status}
  }'
}

# --- 1. Infra health -----------------------------------------------------

section "1. Infra health checks"
echo "registry:     $(curl -s -o /dev/null -w '%{http_code}' "$REGISTRY/health")"
echo "orchestrator: $(curl -s "$ORCH/health" | jq -c .)"
for p in 9001 9002 9003 9004 9005 9006; do
  echo "agent :$p   $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$p/health)"
done

# --- 2. Registry discovery (raw, bypassing the orchestrator) -------------

section "2. Registry discovery: POST /discover for validation_compliance"
curl -s -X POST "$REGISTRY/discover" \
  -H 'Content-Type: application/json' \
  -d '{"capability_codes": ["validation_compliance"]}' | jq '{count, agents: [.agents[].instance_id]}'

# --- 3. Raw agent-to-agent MCP call (bypassing the orchestrator) ---------

section "3. Direct enveloped MCP call to the contract agent (no orchestrator)"
curl -s -X POST "$AGENT_CONTRACT/mcp" -H 'Content-Type: application/json' -d '{
  "message_id": "manual-test-001",
  "spec_version": "0.1.0",
  "phase": "contract_management",
  "timestamp": "2026-06-18T10:00:00Z",
  "payload": {
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": {
      "name": "contract.process",
      "arguments": {
        "objective": "Update customer address",
        "task_data": {"customer_id": "CUST-MANUAL-1", "new_address": {"country": "GB"}, "account_value": 1500},
        "source_context": {"application_id": "manual-test"}
      }
    }
  }
}' | jq '.payload.result.content[0].text | fromjson'

# --- 4. Scenario: approved (golden path) ----------------------------------

section "4. Scenario: approved"
EXEC_APPROVED=$(submit_scenario approved)
echo "execution_id=$EXEC_APPROVED"
echo "final status: $(wait_for_status "$EXEC_APPROVED")"
summarize "$EXEC_APPROVED"

# --- 5. Scenario: blocked (policy violation -> auto-rejected) ------------

section "5. Scenario: blocked"
EXEC_BLOCKED=$(submit_scenario blocked)
echo "execution_id=$EXEC_BLOCKED"
echo "final status: $(wait_for_status "$EXEC_BLOCKED")"
summarize "$EXEC_BLOCKED"

# --- 6. Scenario: sla_breach (execution trips the breach state machine) --

section "6. Scenario: sla_breach"
EXEC_SLA=$(submit_scenario sla_breach)
echo "execution_id=$EXEC_SLA"
echo "final status: $(wait_for_status "$EXEC_SLA")"
summarize "$EXEC_SLA"

# --- 7. Scenario: hitl_required (pauses for a human decision) ------------

section "7. Scenario: hitl_required - pause"
EXEC_HITL=$(submit_scenario hitl_required)
echo "execution_id=$EXEC_HITL"
echo "status after validation: $(wait_for_status "$EXEC_HITL")"
summarize "$EXEC_HITL"

section "7b. Pending HITL queue"
curl -s "$ORCH/api/v1/executions/pending-hitl" | jq '{total, pending: [.executions[].execution_id]}'

section "7c. Approving the pending decision"
curl -s -X POST "$ORCH/api/v1/executions/$EXEC_HITL/hitl-decision" \
  -H 'Content-Type: application/json' \
  -d '{"decision": "approved", "reviewer_id": "test-script-reviewer"}' | jq .
echo "final status: $(wait_for_status "$EXEC_HITL")"
summarize "$EXEC_HITL"

# --- 8. Custom (non-canned) task_data submission --------------------------

section "8. Custom task_data submission (not a canned scenario)"
EXEC_CUSTOM=$(submit_task_data '{
  "task_data": {
    "objective": "Update customer address - ad hoc test",
    "customer_id": "CUST-CUSTOM-1",
    "new_address": {"country": "DE"},
    "account_value": 4000,
    "verification_documents": [{"type": "passport"}, {"type": "utility_bill"}]
  }
}')
echo "execution_id=$EXEC_CUSTOM"
echo "final status: $(wait_for_status "$EXEC_CUSTOM")"
summarize "$EXEC_CUSTOM"

# --- 9. Fleet-wide views ---------------------------------------------------

section "9. KPIs"
curl -s "$ORCH/api/v1/kpis" | jq .

section "9b. Recent executions"
curl -s "$ORCH/api/v1/executions?limit=10" | jq '.executions[] | {execution_id, scenario, status}'

section "9c. Recent events"
curl -s "$ORCH/api/v1/events?limit=10" | jq '.events[] | {execution_id, phase, event_type, timestamp}'

section "Done"
