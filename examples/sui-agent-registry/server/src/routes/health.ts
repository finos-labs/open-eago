import type { FastifyInstance } from "fastify";
import type { AgentStore } from "../registry-sync.js";

export async function healthRoute(
  app: FastifyInstance,
  options: { store: AgentStore }
): Promise<void> {
  app.get(
    "/health",
    {
      schema: {
        description: "Server health check",
        tags: ["system"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              agentCount: { type: "number" },
              timestamp: { type: "string" },
            },
          },
        },
      },
    },
    async (_req, reply) => {
      reply.send({
        status: "ok",
        agentCount: options.store.count(),
        timestamp: new Date().toISOString(),
      });
    }
  );
}
