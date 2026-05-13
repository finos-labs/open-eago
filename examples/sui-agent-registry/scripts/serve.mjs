/**
 * serve.mjs — Tiny HTTP server to serve agent.json at /.well-known/agent.json
 *
 * Usage:
 *   node serve.mjs [port]    # default port: 8080
 */

import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const port = Number(process.argv[2] ?? 8080);
const __dir = dirname(fileURLToPath(import.meta.url));
const agentCard = readFileSync(join(__dir, "agent.json"), "utf8");

const server = createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (url === "/agent.json" || url === "/.well-known/agent.json") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(agentCard);
    console.log(`[${new Date().toISOString()}] GET ${req.url} → 200`);
  } else {
    res.writeHead(404);
    res.end("Not found");
    console.log(`[${new Date().toISOString()}] GET ${req.url} → 404`);
  }
});

server.listen(port, () => {
  console.log(`Agent card server listening on http://localhost:${port}`);
  console.log(`  http://localhost:${port}/agent.json`);
  console.log(`  http://localhost:${port}/.well-known/agent.json`);
});
