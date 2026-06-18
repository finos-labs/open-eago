import { motion } from "framer-motion";
import type { Kpis } from "../lib/types";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <motion.div
      key={value}
      initial={{ opacity: 0.4, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="flex-1 px-4 py-3 border-r border-slate-800 last:border-r-0"
    >
      <div className="text-2xl font-bold text-white tabular-nums">{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </motion.div>
  );
}

export function KpiStrip({ kpis }: { kpis: Kpis | null }) {
  return (
    <div className="flex rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
      <Stat label="Total Executions" value={kpis?.total_executions ?? "-"} />
      <Stat label="Completed" value={kpis?.completed ?? "-"} />
      <Stat label="Rejected" value={kpis?.rejected ?? "-"} />
      <Stat label="Awaiting HITL" value={kpis?.awaiting_hitl ?? "-"} />
      <Stat
        label="Approval Rate"
        value={kpis?.approval_rate != null ? `${Math.round(kpis.approval_rate * 100)}%` : "-"}
      />
    </div>
  );
}
