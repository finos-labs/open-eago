/**
 * mcp-server-base.js
 *
 * Shared HTTP / JSON-RPC 2.0 server factory for all onboarding MCP servers.
 * Each agent server imports this module and calls startMcpServer({ tools, resources, prompts }).
 *
 * CLI convention: node <server>.js <path-to-agent-card.json> <port>
 *
 * Endpoints:
 *   GET  /               → agent card JSON
 *   GET  /.well-known/agent → agent card JSON
 *   POST /mcp            → MCP JSON-RPC 2.0
 */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Bounds state ──────────────────────────────────────────────────────────────

const BOUNDS_STATE_PATH = path.resolve(__dirname, 'bounds-state.json');

function readBoundsState() {
  try { return JSON.parse(fs.readFileSync(BOUNDS_STATE_PATH, 'utf8')); }
  catch { return {}; }
}

function toolSuspensionStatus(toolName) {
  const entry = readBoundsState()[toolName];
  if (!entry || entry.enabled !== false) return { suspended: false };
  return { suspended: true, reason: entry.disabledReason ?? 'revoked by autonomy bounds' };
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

const rpcError  = (id, code, msg) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message: msg } });
const rpcResult = (id, result)    => ({ jsonrpc: '2.0', id, result });

// ── MCP dispatcher factory ─────────────────────────────────────────────────────

function makeDispatcher(agentCard, agentName, port, tools, resources, prompts) {
  return function handleMcp(body) {
    const { jsonrpc, id, method, params } = body;
    if (jsonrpc !== '2.0') return rpcError(id, -32600, 'Invalid Request');

    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: '2024-11-05',
        serverInfo: { name: agentName, version: '1.0.0' },
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
    }

    if (method === 'notifications/initialized') return rpcResult(id, null);

    // ── tools ─────────────────────────────────────────────────────────────────
    if (method === 'tools/list') {
      const builtins = [
        { name: 'agent/info', description: 'Returns the agent card.', inputSchema: { type: 'object', properties: {}, required: [] } },
        { name: 'agent/ping', description: 'Health check – returns pong.', inputSchema: { type: 'object', properties: {}, required: [] } },
      ];
      const custom = Object.entries(tools).map(([name, def]) => {
        const susp  = toolSuspensionStatus(name);
        const entry = { name, description: def.description, inputSchema: def.inputSchema };
        if (susp.suspended) { entry.x_suspended = true; entry.x_suspension_reason = susp.reason; }
        return entry;
      });
      return rpcResult(id, { tools: [...builtins, ...custom] });
    }

    if (method === 'tools/call') {
      const name = params?.name;
      if (name === 'agent/info') return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(agentCard, null, 2) }] });
      if (name === 'agent/ping') return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify({ status: 'pong', agent: agentName, port }) }] });

      const tool = tools[name];
      if (!tool) return rpcError(id, -32601, `Unknown tool: ${name}`);

      const susp = toolSuspensionStatus(name);
      if (susp.suspended) return rpcError(id, -32001, `tool suspended: ${susp.reason}`);

      try {
        const result = tool.handler(params?.arguments ?? {});
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return rpcError(id, -32000, `Tool error: ${err.message}`);
      }
    }

    // ── resources ─────────────────────────────────────────────────────────────
    if (method === 'resources/list') return rpcResult(id, { resources });

    if (method === 'resources/read') {
      const uri = params?.uri;
      const resolver = resources.find(r => r._resolve);
      const resolved = resolver?._resolve(uri);
      if (!resolved) return rpcError(id, -32602, `Unknown resource URI: ${uri}`);
      return rpcResult(id, { contents: [resolved] });
    }

    // ── prompts ───────────────────────────────────────────────────────────────
    if (method === 'prompts/list') {
      return rpcResult(id, {
        prompts: Object.entries(prompts).map(([name, def]) => ({
          name, description: def.description, arguments: def.arguments ?? [],
        })),
      });
    }

    if (method === 'prompts/get') {
      const prompt = prompts[params?.name];
      if (!prompt) return rpcError(id, -32602, `Unknown prompt: ${params?.name}`);
      return rpcResult(id, { description: prompt.description, messages: prompt.template(params?.arguments ?? {}) });
    }

    return rpcError(id, -32601, `Method not found: ${method}`);
  };
}

// ── Public: start server ──────────────────────────────────────────────────────

/**
 * @param {{ tools: object, resources: Array, prompts: object, serverLabel: string }} opts
 */
export function startMcpServer({ tools = {}, resources = [], prompts = {}, serverLabel }) {
  const [, , cardPath, portArg] = process.argv;
  if (!cardPath || !portArg) {
    console.error(`Usage: node ${serverLabel}.js <agent-card.json> <port>`);
    process.exit(1);
  }
  const PORT = parseInt(portArg, 10);
  if (Number.isNaN(PORT)) { console.error(`Invalid port: ${portArg}`); process.exit(1); }

  const absoluteCardPath = path.resolve(cardPath);
  let agentCard = JSON.parse(fs.readFileSync(absoluteCardPath, 'utf8'));
  agentCard = { ...agentCard, endpoint: `http://localhost:${PORT}` };
  const agentName = agentCard.name ?? path.basename(cardPath, '.json');

  const handleMcp = makeDispatcher(agentCard, agentName, PORT, tools, resources, prompts);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && ['/', '/.well-known/agent'].includes(url.pathname)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agentCard, null, 2));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch { res.writeHead(400); res.end(JSON.stringify(rpcError(null, -32700, 'Parse error'))); return; }
        const isBatch = Array.isArray(parsed);
        const resps   = (isBatch ? parsed : [parsed]).map(handleMcp).filter(Boolean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(isBatch ? resps : resps[0]));
      });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(PORT, () =>
    console.log(`[${agentName}] ${serverLabel} MCP server → http://localhost:${PORT}  (${absoluteCardPath})`)
  );

  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT',  () => server.close(() => process.exit(0)));

  return { agentCard, agentName, PORT };
}
