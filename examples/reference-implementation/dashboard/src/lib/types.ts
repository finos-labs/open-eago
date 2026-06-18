export type Phase =
  | "contract_management"
  | "planning_negotiation"
  | "validation_compliance"
  | "execution_resilience"
  | "context_state_management"
  | "communication_delivery";

export const PHASES: Phase[] = [
  "contract_management",
  "planning_negotiation",
  "validation_compliance",
  "execution_resilience",
  "context_state_management",
  "communication_delivery",
];

export const PHASE_LABELS: Record<Phase, string> = {
  contract_management: "Contract",
  planning_negotiation: "Planning",
  validation_compliance: "Validation",
  execution_resilience: "Execution",
  context_state_management: "Context",
  communication_delivery: "Communication",
};

export type RiskTier = "low" | "medium" | "high" | "critical";

export interface RiskAssessment {
  composite_risk_score: number;
  risk_tier: RiskTier;
  dimension_scores: {
    financial_risk: number;
    operational_risk: number;
    compliance_risk: number;
    security_risk: number;
  };
  escalation_outcome: string;
  hitl_required: boolean;
}

export interface PhaseRecord {
  document: Record<string, unknown>;
  conformant: boolean;
  errors: string[];
  recorded_at: string;
}

export interface ExecutionDoc {
  _id: string;
  execution_id: string;
  session_id: string;
  scenario: string | null;
  status: "running" | "awaiting_hitl" | "completed" | "rejected" | "failed";
  task_data: Record<string, unknown>;
  phases: Partial<Record<Phase, PhaseRecord>>;
  validation_draft?: { risk_assessment: RiskAssessment; [k: string]: unknown };
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface FeedEvent {
  execution_id: string;
  phase: string;
  event_type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface AgentInfo {
  address: string;
  instance_id: string;
  capability_codes: string[];
  jurisdiction: string;
  reliability: number;
  health_status: string;
  uptime_percentage: number;
}

export interface Kpis {
  total_executions: number;
  completed: number;
  rejected: number;
  awaiting_hitl: number;
  approval_rate: number | null;
}
