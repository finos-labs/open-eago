import clsx from "clsx";
import { Card } from "./Card";
import { Badge } from "./Badge";
import type { ExecutionDoc } from "../lib/types";

const STATES = ["active", "at_risk", "breached", "fallback_activated", "escalated", "completed"];

interface SlaStatus {
  breach_state: string;
  overall_sla_status: string;
  slo_results?: {
    latency_p99_ms?: { target: number; observed: number; status: string };
  };
}

export function SlaStateMachine({ execution }: { execution: ExecutionDoc | null }) {
  const doc = execution?.phases.execution_resilience?.document as
    | { sla_compliance_status: SlaStatus }
    | undefined;
  const sla = doc?.sla_compliance_status;
  const currentIdx = sla ? STATES.indexOf(sla.breach_state) : -1;
  const latency = sla?.slo_results?.latency_p99_ms;

  return (
    <Card
      title="SLA Breach State Machine"
      subtitle="Execution & Resilience"
      right={sla && <Badge value={sla.overall_sla_status} label={sla.overall_sla_status.toUpperCase()} />}
    >
      {sla ? (
        <div className="space-y-4">
          <div className="flex items-center gap-1.5 flex-wrap">
            {STATES.map((s, idx) => (
              <span
                key={s}
                className={clsx(
                  "px-2 py-1 rounded-md text-[11px] font-medium border",
                  idx === currentIdx
                    ? "border-orange-500 bg-orange-500/20 text-orange-300"
                    : idx < currentIdx
                      ? "border-slate-700 bg-slate-800 text-slate-400"
                      : "border-slate-800 bg-slate-900/40 text-slate-600",
                )}
              >
                {s.replace(/_/g, " ")}
              </span>
            ))}
          </div>
          {latency && (
            <div className="text-xs text-slate-400 flex gap-4">
              <span>
                p99 target: <span className="text-slate-200 font-mono">{latency.target}ms</span>
              </span>
              <span>
                observed:{" "}
                <span
                  className={clsx(
                    "font-mono",
                    latency.status === "met" ? "text-emerald-400" : "text-rose-400",
                  )}
                >
                  {latency.observed}ms
                </span>
              </span>
            </div>
          )}
        </div>
      ) : (
        <div className="h-24 flex items-center justify-center text-sm text-slate-600">
          No execution data yet
        </div>
      )}
    </Card>
  );
}
