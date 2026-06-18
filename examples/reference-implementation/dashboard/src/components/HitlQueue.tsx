import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Card } from "./Card";
import { Badge } from "./Badge";
import { submitHitlDecision } from "../lib/api";
import type { ExecutionDoc } from "../lib/types";

export function HitlQueue({
  pending,
  onDecided,
  onSelect,
}: {
  pending: ExecutionDoc[];
  onDecided: () => void;
  onSelect: (executionId: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  async function decide(executionId: string, decision: "approved" | "rejected") {
    setBusy(executionId);
    try {
      await submitHitlDecision(executionId, decision, "dashboard-reviewer");
      onDecided();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="HITL Approval Queue" subtitle="Mandatory human gate for high/critical risk">
      {pending.length === 0 ? (
        <div className="h-24 flex items-center justify-center text-sm text-slate-600">Queue is empty</div>
      ) : (
        <div className="space-y-2">
          <AnimatePresence>
            {pending.map((ex) => {
              const risk = ex.validation_draft?.risk_assessment;
              return (
                <motion.div
                  key={ex.execution_id}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 40 }}
                  className="flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2"
                >
                  <button onClick={() => onSelect(ex.execution_id)} className="text-left">
                    <div className="text-sm font-mono text-slate-200">{ex.execution_id}</div>
                    <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
                      {risk && <Badge value={risk.risk_tier} label={`${risk.risk_tier} · ${risk.composite_risk_score.toFixed(2)}`} />}
                      <span>{String(ex.task_data.customer_id ?? "")}</span>
                    </div>
                  </button>
                  <div className="flex gap-2">
                    <button
                      disabled={busy === ex.execution_id}
                      onClick={() => decide(ex.execution_id, "approved")}
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      Approve
                    </button>
                    <button
                      disabled={busy === ex.execution_id}
                      onClick={() => decide(ex.execution_id, "rejected")}
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </Card>
  );
}
