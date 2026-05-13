import type { FastifyInstance } from "fastify";
import type { AgentStore } from "../registry-sync.js";

export async function agentsRoute(
  app: FastifyInstance,
  options: { store: AgentStore }
): Promise<void> {
  /** GET /agents — paginated list */
  app.get(
    "/agents",
    {
      schema: {
        description: "List registered agents",
        tags: ["agents"],
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
            active: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              data: { type: "array", items: { type: "object", additionalProperties: true } },
              total: { type: "number" },
              page: { type: "number" },
              limit: { type: "number" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { page = 1, limit = 20, active } = req.query as {
        page?: number;
        limit?: number;
        active?: boolean;
      };

      let all = options.store.getAll();
      if (active !== undefined) {
        all = all.filter((a) => a.active === active);
      }

      const total = all.length;
      const offset = (page - 1) * limit;
      const data = all.slice(offset, offset + limit);

      reply.send({ data, total, page, limit });
    }
  );

  /** GET /agents/:agentId — single agent detail */
  app.get(
    "/agents/:agentId",
    {
      schema: {
        description: "Get agent by ID",
        tags: ["agents"],
        params: {
          type: "object",
          properties: {
            agentId: { type: "integer", minimum: 0 },
          },
          required: ["agentId"],
        },
        response: {
          200: { type: "object", additionalProperties: true },
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { agentId } = req.params as { agentId: number };
      const agent = options.store.get(agentId);
      if (!agent) {
        reply.code(404).send({ error: `Agent ${agentId} not found` });
        return;
      }
      reply.send(agent);
    }
  );
}
