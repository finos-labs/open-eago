import { useCallback, useEffect, useState } from "react";
import { Header } from "./components/Header";
import { KpiStrip } from "./components/KpiStrip";
import { ScenarioLauncher } from "./components/ScenarioLauncher";
import { ExecutionsList } from "./components/ExecutionsList";
import { PhasePipeline } from "./components/PhasePipeline";
import { RiskRadarPanel } from "./components/RiskRadarPanel";
import { SlaStateMachine } from "./components/SlaStateMachine";
import { HitlQueue } from "./components/HitlQueue";
import { EventFeed } from "./components/EventFeed";
import { AgentRegistryPanel } from "./components/AgentRegistryPanel";
import { useEagoFeed } from "./lib/useEagoFeed";
import { getExecution, getKpis, listAgents, listExecutions, listPendingHitl } from "./lib/api";
import type { AgentInfo, ExecutionDoc, Kpis } from "./lib/types";

function App() {
  const { events, connected } = useEagoFeed();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedExecution, setSelectedExecution] = useState<ExecutionDoc | null>(null);
  const [executions, setExecutions] = useState<ExecutionDoc[]>([]);
  const [pendingHitl, setPendingHitl] = useState<ExecutionDoc[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [kpis, setKpis] = useState<Kpis | null>(null);

  const refreshLists = useCallback(async () => {
    const [execResp, hitlResp, agentsResp, kpisResp] = await Promise.all([
      listExecutions(50),
      listPendingHitl(),
      listAgents(),
      getKpis(),
    ]);
    setExecutions(execResp.executions);
    setPendingHitl(hitlResp.executions);
    setAgents(agentsResp.agents);
    setKpis(kpisResp);
  }, []);

  useEffect(() => {
    refreshLists();
  }, [refreshLists]);

  // Every live event is a signal to refetch - push-triggered, not interval-polled.
  useEffect(() => {
    if (events.length === 0) return;
    refreshLists();
    const latest = events[0];
    if (selectedId === null) {
      setSelectedId(latest.execution_id);
    } else if (latest.execution_id === selectedId) {
      getExecution(selectedId).then(setSelectedExecution);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.length]);

  useEffect(() => {
    if (selectedId) getExecution(selectedId).then(setSelectedExecution);
  }, [selectedId]);

  return (
    <div className="min-h-screen flex flex-col">
      <Header connected={connected} />
      <main className="flex-1 p-6 space-y-6 max-w-[1600px] w-full mx-auto">
        <KpiStrip kpis={kpis} />

        <div className="grid grid-cols-3 gap-6">
          <div className="col-span-2 space-y-6">
            <PhasePipeline execution={selectedExecution} />
            <div className="grid grid-cols-2 gap-6">
              <RiskRadarPanel execution={selectedExecution} />
              <SlaStateMachine execution={selectedExecution} />
            </div>
            <HitlQueue pending={pendingHitl} onDecided={refreshLists} onSelect={setSelectedId} />
          </div>

          <div className="space-y-6">
            <ScenarioLauncher onSubmitted={setSelectedId} />
            <ExecutionsList executions={executions} selectedId={selectedId} onSelect={setSelectedId} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <EventFeed events={events} />
          <AgentRegistryPanel agents={agents} />
        </div>
      </main>
    </div>
  );
}

export default App;
