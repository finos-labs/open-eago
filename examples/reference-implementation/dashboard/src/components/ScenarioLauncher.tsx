import { useState } from "react";
import { Card } from "./Card";
import { submitScenario } from "../lib/api";

const SCENARIOS: { key: string; label: string; description: string; accent: string }[] = [
  {
    key: "approved",
    label: "Approved",
    description: "Low risk - auto-approved golden path",
    accent: "hover:border-emerald-500/50 hover:bg-emerald-500/5",
  },
  {
    key: "hitl_required",
    label: "HITL Required",
    description: "High risk - pauses for human approval",
    accent: "hover:border-amber-500/50 hover:bg-amber-500/5",
  },
  {
    key: "blocked",
    label: "Blocked",
    description: "Policy violation - auto-rejected",
    accent: "hover:border-rose-500/50 hover:bg-rose-500/5",
  },
  {
    key: "sla_breach",
    label: "SLA Breach",
    description: "Execution trips the breach state machine",
    accent: "hover:border-orange-500/50 hover:bg-orange-500/5",
  },
];

export function ScenarioLauncher({ onSubmitted }: { onSubmitted: (executionId: string) => void }) {
  const [pending, setPending] = useState<string | null>(null);

  async function launch(key: string) {
    setPending(key);
    try {
      const { execution_id } = await submitScenario(key);
      onSubmitted(execution_id);
    } finally {
      setPending(null);
    }
  }

  return (
    <Card title="Scenario Launcher" subtitle="Drive the pipeline through a canned governance branch">
      <div className="grid grid-cols-2 gap-3">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            disabled={pending !== null}
            onClick={() => launch(s.key)}
            className={`text-left rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2.5 transition-colors disabled:opacity-50 ${s.accent}`}
          >
            <div className="text-sm font-semibold text-slate-100">
              {pending === s.key ? "Submitting..." : s.label}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">{s.description}</div>
          </button>
        ))}
      </div>
    </Card>
  );
}
