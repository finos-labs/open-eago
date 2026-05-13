import type { FastifyInstance } from "fastify";
import type { AgentStore, AgentStatus } from "../registry-sync.js";

interface DiscoverBody {
  capability_codes?: string[];
  compliance?: string[];
  jurisdiction?: string;
  min_reliability?: number;
  min_uptime_pct?: number;
  max_latency_p99_ms?: number;
  exclude_status?: AgentStatus[];
  tags?: string[];
  page?: number;
  limit?: number;
}

export async function discoverRoute(
  app: FastifyInstance,
  options: { store: AgentStore }
): Promise<void> {
  app.post(
    "/discover",
    {
      schema: {
        description:
          "Discover agents matching the given criteria. Always enforces minimum reliability ≥ 0.95 and uptime ≥ 99.0% per spec §4.2.",
        tags: ["discovery"],
        body: {
          type: "object",
          properties: {
            capability_codes: { type: "array", items: { type: "string" } },
            compliance: { type: "array", items: { type: "string" } },
            jurisdiction: { type: "string" },
            min_reliability: {
              type: "number",
              minimum: 0,
              maximum: 1,
              description: "Minimum reliability score (0–1). Floor is 0.95.",
            },
            min_uptime_pct: {
              type: "number",
              minimum: 0,
              maximum: 100,
              description: "Minimum uptime percentage. Floor is 99.0.",
            },
            max_latency_p99_ms: { type: "number", minimum: 0 },
            exclude_status: {
              type: "array",
              items: { type: "string", enum: ["healthy", "degraded", "suspended", "unknown"] },
            },
            tags: { type: "array", items: { type: "string" } },
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              data: { type: "array", items: { type: "object" } },
              total: { type: "number" },
              filtered_out: {
                type: "number",
                description: "Number of registered agents excluded by the filter criteria",
              },
              page: { type: "number" },
              limit: { type: "number" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as DiscoverBody;
      const page = body.page ?? 1;
      const limit = body.limit ?? 20;

      const { agents, filteredOut } = options.store.discover({
        capabilityCodes: body.capability_codes,
        compliance: body.compliance,
        jurisdiction: body.jurisdiction,
        minReliability: body.min_reliability,
        minUptimePct: body.min_uptime_pct,
        maxLatencyP99Ms: body.max_latency_p99_ms,
        excludeStatus: body.exclude_status,
        tags: body.tags,
      });

      const total = agents.length;
      const offset = (page - 1) * limit;
      const data = agents.slice(offset, offset + limit);

      reply.send({ data, total, filtered_out: filteredOut, page, limit });
    }
  );
}
