import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from "recharts";
import { Card } from "./Card";
import { Badge } from "./Badge";
import type { ExecutionDoc, RiskAssessment } from "../lib/types";

function extractRiskAssessment(execution: ExecutionDoc | null): RiskAssessment | null {
  if (!execution) return null;
  const validation = execution.phases.validation_compliance?.document as
    | { risk_assessment: RiskAssessment }
    | undefined;
  if (validation) return validation.risk_assessment;
  if (execution.validation_draft) return execution.validation_draft.risk_assessment;
  return null;
}

export function RiskRadarPanel({ execution }: { execution: ExecutionDoc | null }) {
  const risk = extractRiskAssessment(execution);

  const data = risk
    ? [
        { dimension: "Financial", score: risk.dimension_scores.financial_risk },
        { dimension: "Operational", score: risk.dimension_scores.operational_risk },
        { dimension: "Compliance", score: risk.dimension_scores.compliance_risk },
        { dimension: "Security", score: risk.dimension_scores.security_risk },
      ]
    : [];

  return (
    <Card
      title="Composite Risk Score"
      subtitle="Validation & Compliance · four-dimension model"
      right={
        risk && (
          <div className="flex items-center gap-2">
            <Badge value={risk.risk_tier} label={risk.risk_tier.toUpperCase()} />
            <span className="text-sm font-mono text-slate-300">{risk.composite_risk_score.toFixed(3)}</span>
          </div>
        )
      }
    >
      {risk ? (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={data}>
              <PolarGrid stroke="#1e293b" />
              <PolarAngleAxis dataKey="dimension" tick={{ fill: "#94a3b8", fontSize: 11 }} />
              <PolarRadiusAxis domain={[0, 1]} tick={false} axisLine={false} />
              <Radar dataKey="score" stroke="#818cf8" fill="#818cf8" fillOpacity={0.35} />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="h-56 flex items-center justify-center text-sm text-slate-600">
          No risk assessment yet
        </div>
      )}
    </Card>
  );
}
