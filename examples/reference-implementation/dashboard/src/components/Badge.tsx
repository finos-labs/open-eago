import clsx from "clsx";

const TIER_COLORS: Record<string, string> = {
  low: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  critical: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  completed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  approved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  met: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  running: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  awaiting_hitl: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  rejected: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  breached: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  failed: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  healthy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
};

export function Badge({ value, label }: { value: string; label?: string }) {
  const color = TIER_COLORS[value] ?? "bg-slate-500/15 text-slate-400 border-slate-500/30";
  return (
    <span className={clsx("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border", color)}>
      {label ?? value}
    </span>
  );
}
