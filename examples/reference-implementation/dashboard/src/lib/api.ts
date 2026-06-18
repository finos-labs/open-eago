import type { AgentInfo, ExecutionDoc, Kpis } from "./types";

const BASE = "/api/v1";

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${body}`);
  }
  return resp.json() as Promise<T>;
}

export async function submitScenario(scenario: string): Promise<{ execution_id: string }> {
  const resp = await fetch(`${BASE}/executions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenario }),
  });
  return json(resp);
}

export async function listExecutions(limit = 50): Promise<{ executions: ExecutionDoc[] }> {
  return json(await fetch(`${BASE}/executions?limit=${limit}`));
}

export async function getExecution(executionId: string): Promise<ExecutionDoc> {
  return json(await fetch(`${BASE}/executions/${executionId}`));
}

export async function listPendingHitl(): Promise<{ executions: ExecutionDoc[] }> {
  return json(await fetch(`${BASE}/executions/pending-hitl`));
}

export async function submitHitlDecision(
  executionId: string,
  decision: "approved" | "rejected" | "modified",
  reviewerId: string,
): Promise<unknown> {
  const resp = await fetch(`${BASE}/executions/${executionId}/hitl-decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision, reviewer_id: reviewerId }),
  });
  return json(resp);
}

export async function listAgents(): Promise<{ agents: AgentInfo[] }> {
  return json(await fetch(`${BASE}/agents`));
}

export async function getKpis(): Promise<Kpis> {
  return json(await fetch(`${BASE}/kpis`));
}
