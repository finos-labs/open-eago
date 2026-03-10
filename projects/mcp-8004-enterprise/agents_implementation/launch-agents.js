/**
 * launch-agents.js
 *
 * Spawns one MCP server process per agent card in agents/*.json.
 * The server script is determined by the agent's capabilities field.
 *
 * Port is read from the agent card's endpoint field (e.g. "http://localhost:8010" → 8010).
 *
 * Usage:
 *   node agents_implementation/launch-agents.js
 *
 * Ctrl-C stops all child processes.
 */

import { spawn }  from 'node:child_process';
import fs         from 'node:fs';
import path       from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR  = path.resolve(__dirname, '..', 'agents');
const SERVERS_DIR = __dirname;

// ── Capability → server script mapping ───────────────────────────────────────

const CAPABILITY_TO_SERVER = {
  'aml_review':         'aml-server.js',
  'credit_review':      'credit-risk-server.js',
  'legal_review':       'legal-server.js',
  'orchestrate_onboarding': 'onboarding-orchestrator-server.js',
  'setup_legal_entity': 'client-setup-server.js',
  'setup_account':      'client-setup-server.js',
  'setup_products':     'client-setup-server.js',
  'submit_documents':   'hf-document-server.js',
  'credit_negotiation': 'hf-credit-negotiator-server.js',
  'legal_negotiation':  'hf-legal-server.js',
};

// ── Load agent cards ──────────────────────────────────────────────────────────

const cards = fs.readdirSync(AGENTS_DIR)
  .filter(f => f.endsWith('.json') && !f.startsWith('.'))
  .map(f => ({
    file: f,
    card: JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')),
    cardPath: path.join(AGENTS_DIR, f),
  }));

if (cards.length === 0) {
  console.error('No agent cards found in', AGENTS_DIR);
  process.exit(1);
}

// ── Spawn servers ─────────────────────────────────────────────────────────────

const children = [];

for (const { file, card, cardPath } of cards) {
  const cap    = card.capabilities?.[0];
  const server = CAPABILITY_TO_SERVER[cap];

  if (!server) {
    console.warn(`[launch-agents] Skipping ${file}: no server mapped for capability "${cap}"`);
    continue;
  }

  const serverPath = path.join(SERVERS_DIR, server);
  if (!fs.existsSync(serverPath)) {
    console.warn(`[launch-agents] Skipping ${file}: server script not found at ${serverPath}`);
    continue;
  }

  // Extract port from endpoint URL
  let port;
  try {
    port = new URL(card.endpoint).port;
  } catch {
    console.warn(`[launch-agents] Skipping ${file}: invalid endpoint "${card.endpoint}"`);
    continue;
  }

  console.log(`[launch-agents] Starting ${card.name} → ${server}:${port}`);

  const child = spawn(
    process.execPath,
    [serverPath, cardPath, port],
    { stdio: 'inherit', env: process.env }
  );

  child.on('exit', (code, signal) => {
    console.log(`[launch-agents] ${card.name} exited (code=${code} signal=${signal})`);
  });

  children.push({ name: card.name, child });
}

console.log(`\n[launch-agents] ${children.length} agent server(s) running. Ctrl-C to stop all.\n`);

// ── Shutdown ──────────────────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[launch-agents] Shutting down…');
  for (const { name, child } of children) {
    console.log(`[launch-agents]   stopping ${name}`);
    child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
