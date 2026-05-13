/**
 * SUI Agentic Registry — Discovery Server
 *
 * Start: node dist/index.js
 * Dev:   tsx watch src/index.ts
 *
 * Reads config from config.yaml in the current working directory,
 * or set CONFIG_PATH env var to override.
 */
import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { loadConfig } from "./config.js";
import { AgentStore, RegistrySync } from "./registry-sync.js";
import { healthRoute } from "./routes/health.js";
import { agentsRoute } from "./routes/agents.js";
import { discoverRoute } from "./routes/discover.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env["CONFIG_PATH"]);
  const store = new AgentStore();
  const sync = new RegistrySync(config, store);

  const app = Fastify({ logger: true });

  await app.register(fastifyCors, { origin: true });

  if (config.server.swagger) {
    await app.register(fastifySwagger, {
      openapi: {
        info: {
          title: "SUI Agentic Registry API",
          description:
            "Discovery and query API for the SUI A2A Agent Registry. " +
            "Inspired by ERC-8004 (Trustless Agents) and FINOS OpenEAGO.",
          version: "0.1.0",
        },
        servers: [
          {
            url: `http://${config.server.host}:${config.server.port}`,
            description: "Local server",
          },
        ],
      },
    });

    await app.register(fastifySwaggerUi, {
      routePrefix: config.server.swaggerPath,
    });
  }

  await app.register(healthRoute, { store });
  await app.register(agentsRoute, { store });
  await app.register(discoverRoute, { store });

  // Start sync before accepting requests
  await sync.start();

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    sync.stop();
    await app.close();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  await app.listen({ host: config.server.host, port: config.server.port });
  console.log(
    `[server] SUI Agentic Registry API listening on ${config.server.host}:${config.server.port}`
  );
  if (config.server.swagger) {
    console.log(
      `[server] Swagger UI at http://localhost:${config.server.port}${config.server.swaggerPath}`
    );
  }
}

main().catch((err) => {
  console.error("[server] Fatal startup error:", err);
  process.exit(1);
});
