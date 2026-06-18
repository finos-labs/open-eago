import { Card } from "./Card";
import { Badge } from "./Badge";
import type { AgentInfo } from "../lib/types";

export function AgentRegistryPanel({ agents }: { agents: AgentInfo[] }) {
  return (
    <Card title="Agent Registry" subtitle={`${agents.length} agents discovered via examples/agent-registry`}>
      <div className="space-y-1.5">
        {agents.map((a) => (
          <div key={a.instance_id} className="flex items-center justify-between text-xs py-1">
            <div>
              <span className="text-slate-200 font-medium">{a.instance_id}</span>
              <span className="text-slate-600 ml-2 font-mono">{a.address}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-500 font-mono">{(a.reliability * 100).toFixed(0)}% reliable</span>
              <Badge value={a.health_status} />
            </div>
          </div>
        ))}
        {agents.length === 0 && <div className="text-sm text-slate-600 py-2">No agents registered yet</div>}
      </div>
    </Card>
  );
}
