import clsx from "clsx";
import { Card } from "./Card";
import { Badge } from "./Badge";
import type { ExecutionDoc } from "../lib/types";

export function ExecutionsList({
  executions,
  selectedId,
  onSelect,
}: {
  executions: ExecutionDoc[];
  selectedId: string | null;
  onSelect: (executionId: string) => void;
}) {
  return (
    <Card title="Recent Executions" subtitle={`${executions.length} total`}>
      <div className="space-y-1 max-h-72 overflow-y-auto">
        {executions.map((ex) => (
          <button
            key={ex.execution_id}
            onClick={() => onSelect(ex.execution_id)}
            className={clsx(
              "w-full flex items-center justify-between rounded-md px-2.5 py-1.5 text-left transition-colors",
              selectedId === ex.execution_id ? "bg-indigo-500/15 border border-indigo-500/40" : "hover:bg-slate-800/60",
            )}
          >
            <div>
              <div className="text-xs font-mono text-slate-300">{ex.execution_id}</div>
              <div className="text-[11px] text-slate-600">{ex.scenario ?? "custom"}</div>
            </div>
            <Badge value={ex.status} />
          </button>
        ))}
        {executions.length === 0 && <div className="text-sm text-slate-600 py-2">No executions yet</div>}
      </div>
    </Card>
  );
}
