#!/usr/bin/env python3
"""Demo: concurrent multi-agent context updates with CRDT merge.

Scenario: SDLC workflow — 3 agents claim tasks and update context concurrently.

Run:
    cd examples/context-management
    pip install -e .
    python demo.py
"""

from context_management import JournalEntry, RiskContext, RiskDimension, WorkflowContextStore

# ---------------------------------------------------------------------------
# 1. Create shared workflow context
# ---------------------------------------------------------------------------
print("=" * 60)
print("OpenEAGO Context Management — Concurrent Agent Demo")
print("=" * 60)

shared = WorkflowContextStore(
    workflow_id="wf-sdlc-001",
    goal="Automated SDLC: requirements -> design -> implementation -> review",
    sprint="sprint-42",
    compliance_tier="SOC2",
)

shared.update_plan({
    "phases": ["requirements", "design", "implementation", "review"],
    "sla_hours": 48,
})

# ---------------------------------------------------------------------------
# 2. Fork into 3 agent stores (simulating diverged replicas)
# ---------------------------------------------------------------------------
# In production each agent would receive save() bytes over the wire;
# here we simulate by copying the serialised bytes.
agent_a = WorkflowContextStore.load(shared.save())
agent_b = WorkflowContextStore.load(shared.save())
agent_c = WorkflowContextStore.load(shared.save())

# ---------------------------------------------------------------------------
# 3. Each agent performs work concurrently (no coordination)
# ---------------------------------------------------------------------------

# --- Agent A: Requirements analyst ---
agent_a.register_agent("agent-a", {"role": "requirements_analyst", "version": "1.0"})

agent_a.append_journal(JournalEntry(
    agent_id="agent-a", task_id="task-req-001",
    event_type="claimed",
))
agent_a.append_journal(JournalEntry(
    agent_id="agent-a", task_id="task-req-001",
    event_type="started",
    outcome={"approach": "stakeholder-interview"},
))
agent_a.upsert_playbook("requirements", {
    "method": "event-storming",
    "artefacts": ["bounded-contexts.md", "ubiquitous-language.md"],
})
agent_a.update_risk(
    RiskDimension(financial=0.3, operational=0.4, compliance=0.5, security=0.2),
    event={"source": "agent-a", "note": "Compliance gap identified in data retention"},
)
score_a = agent_a.snapshot().risk.composite_score
print(f"\n[AGENT-A] Risk score: {score_a:.4f}  tier: {agent_a.snapshot().risk.tier}")

# --- Agent B: Architect ---
agent_b.register_agent("agent-b", {"role": "architect", "version": "1.0"})

agent_b.append_journal(JournalEntry(
    agent_id="agent-b", task_id="task-design-001",
    event_type="claimed",
))
agent_b.append_journal(JournalEntry(
    agent_id="agent-b", task_id="task-design-001",
    event_type="started",
    outcome={"approach": "C4-model"},
))
agent_b.upsert_playbook("design", {
    "pattern": "hexagonal-architecture",
    "artefacts": ["c4-context.png", "c4-container.png"],
})
agent_b.update_risk(
    RiskDimension(financial=0.6, operational=0.7, compliance=0.8, security=0.6),
    event={"source": "agent-b", "note": "Third-party dependency risk elevated"},
)
score_b = agent_b.snapshot().risk.composite_score
print(f"[AGENT-B] Risk score: {score_b:.4f}  tier: {agent_b.snapshot().risk.tier}")

# --- Agent C: Security reviewer ---
agent_c.register_agent("agent-c", {"role": "security_reviewer", "version": "1.0"})

agent_c.append_journal(JournalEntry(
    agent_id="agent-c", task_id="task-sec-001",
    event_type="claimed",
))
agent_c.append_journal(JournalEntry(
    agent_id="agent-c", task_id="task-sec-001",
    event_type="started",
    outcome={"approach": "STRIDE-threat-model"},
))
agent_c.upsert_playbook("security", {
    "framework": "STRIDE",
    "artefacts": ["threat-model.md", "mitigations.md"],
})
agent_c.update_risk(
    RiskDimension(financial=0.2, operational=0.3, compliance=0.6, security=0.6),
    event={"source": "agent-c", "note": "Auth boundary requires review"},
)
score_c = agent_c.snapshot().risk.composite_score
print(f"[AGENT-C] Risk score: {score_c:.4f}  tier: {agent_c.snapshot().risk.tier}")

# ---------------------------------------------------------------------------
# 4. Merge: agent_b → agent_a, then agent_c → merged
# ---------------------------------------------------------------------------
print("\n--- Merging replicas ---")
agent_a.merge_with(agent_b)
agent_a.merge_with(agent_c)
merged = agent_a  # rename for clarity

snap = merged.snapshot()

# ---------------------------------------------------------------------------
# 5. Verify journal: all 6 entries present
# ---------------------------------------------------------------------------
print(f"\n[MERGE] Journal entries: {len(snap.journal)}")
assert len(snap.journal) == 6, f"Expected 6 journal entries, got {len(snap.journal)}"
agents_in_journal = {e.agent_id for e in snap.journal}
assert agents_in_journal == {"agent-a", "agent-b", "agent-c"}, (
    f"Expected entries from all 3 agents, got: {agents_in_journal}"
)
for entry in snap.journal:
    print(f"  [{entry.agent_id}] {entry.task_id} -> {entry.event_type}")

# ---------------------------------------------------------------------------
# 6. Verify risk: max-score policy
# ---------------------------------------------------------------------------
expected_max = max(score_a, score_b, score_c)
print(f"\n[MERGE] Risk score: {snap.risk.composite_score:.4f}  tier: {snap.risk.tier}")
print(f"        max(score_a, score_b, score_c) = {expected_max:.4f}")

assert abs(snap.risk.composite_score - expected_max) < 1e-9, (
    f"Max-score policy violated: {snap.risk.composite_score} != {expected_max}"
)
expected_tier = RiskContext.score_to_tier(expected_max)
assert snap.risk.tier == expected_tier, (
    f"Tier mismatch: got '{snap.risk.tier}', expected '{expected_tier}' for score {expected_max:.4f}"
)

# ---------------------------------------------------------------------------
# 7. Verify playbook entries from all agents
# ---------------------------------------------------------------------------
print(f"\n[MERGE] Playbook keys: {sorted(snap.playbook.keys())}")
assert set(snap.playbook.keys()) == {"requirements", "design", "security"}, (
    f"Playbook missing entries: {snap.playbook.keys()}"
)

# ---------------------------------------------------------------------------
# 8. Save / load roundtrip
# ---------------------------------------------------------------------------
blob = merged.save()
restored = WorkflowContextStore.load(blob)
snap2 = restored.snapshot()

roundtrip_ok = (
    snap2.workflow_id == snap.workflow_id
    and len(snap2.journal) == len(snap.journal)
    and abs(snap2.risk.composite_score - snap.risk.composite_score) < 1e-9
    and snap2.risk.tier == snap.risk.tier
    and set(snap2.playbook.keys()) == set(snap.playbook.keys())
)
print(f"\n[ROUNDTRIP] Snapshot matches after save/load: {roundtrip_ok}")
assert roundtrip_ok, "Roundtrip produced a different snapshot!"

# ---------------------------------------------------------------------------
# 9. Audit history
# ---------------------------------------------------------------------------
history = merged.history()
print(f"[HISTORY] Automerge change count: {len(history)}")

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print("\n" + "=" * 60)
print("All assertions passed.")
print(f"  Workflow : {snap.workflow_id}")
print(f"  Goal     : {snap.goal}")
print(f"  Journal  : {len(snap.journal)} entries across {len(agents_in_journal)} agents")
print(f"  Risk     : score={snap.risk.composite_score:.4f}  tier={snap.risk.tier}")
print(f"  Playbook : {sorted(snap.playbook.keys())}")
print(f"  Agents   : {sorted(snap.agents.keys())}")
print(f"  Blob     : {len(blob)} bytes")
print(f"  History  : {len(history)} Automerge changes")
print("=" * 60)
