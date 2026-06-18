import { motion } from "framer-motion";
import clsx from "clsx";
import { Card } from "./Card";
import { PHASES, PHASE_LABELS, type ExecutionDoc } from "../lib/types";

type StepStatus = "done" | "warning" | "active" | "awaiting" | "skipped" | "pending";

const STATUS_STYLES: Record<StepStatus, string> = {
  done: "border-emerald-500 bg-emerald-500/15 text-emerald-300",
  warning: "border-rose-500 bg-rose-500/15 text-rose-300",
  active: "border-sky-500 bg-sky-500/15 text-sky-300",
  awaiting: "border-amber-500 bg-amber-500/15 text-amber-300",
  skipped: "border-slate-700 bg-slate-900 text-slate-600",
  pending: "border-slate-700 bg-slate-900/40 text-slate-500",
};

function computeStatuses(execution: ExecutionDoc | null): StepStatus[] {
  if (!execution) return PHASES.map(() => "pending");
  const doneIdx = PHASES.map((p) => (execution.phases[p] ? 1 : 0));
  const lastDone = doneIdx.lastIndexOf(1);

  return PHASES.map((phase, idx) => {
    const record = execution.phases[phase];
    if (record) return record.conformant ? "done" : "warning";
    if (execution.status === "awaiting_hitl" && phase === "validation_compliance") return "awaiting";
    if (idx === lastDone + 1 && execution.status === "running") return "active";
    if (["rejected", "completed", "failed"].includes(execution.status) && idx > lastDone) return "skipped";
    return "pending";
  });
}

export function PhasePipeline({ execution }: { execution: ExecutionDoc | null }) {
  const statuses = computeStatuses(execution);

  return (
    <Card
      title="Phase Pipeline"
      subtitle={execution ? `${execution.execution_id} · ${execution.status}` : "Select or launch an execution"}
    >
      <div className="flex items-center">
        {PHASES.map((phase, idx) => (
          <div key={phase} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-2">
              <motion.div
                animate={statuses[idx] === "active" ? { scale: [1, 1.12, 1] } : { scale: 1 }}
                transition={{ repeat: statuses[idx] === "active" ? Infinity : 0, duration: 1.1 }}
                className={clsx(
                  "h-11 w-11 rounded-full border-2 flex items-center justify-center text-xs font-bold",
                  STATUS_STYLES[statuses[idx]],
                )}
              >
                {idx + 1}
              </motion.div>
              <span className="text-xs text-slate-400 whitespace-nowrap">{PHASE_LABELS[phase]}</span>
            </div>
            {idx < PHASES.length - 1 && (
              <div
                className={clsx(
                  "h-0.5 flex-1 mx-1 mb-5 rounded",
                  statuses[idx] === "done" ? "bg-emerald-500/60" : "bg-slate-800",
                )}
              />
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
