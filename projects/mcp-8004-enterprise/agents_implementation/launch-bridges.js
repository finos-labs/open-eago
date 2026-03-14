/**
 * launch-bridges.js
 *
 * Spawns all onboarding oracle bridge processes.
 *
 * Usage:
 *   node agents_implementation/launch-bridges.js \
 *     --onboarding-registry 0x... \
 *     --aml-contract        0x... \
 *     --credit-contract     0x... \
 *     --legal-contract      0x... \
 *     --setup-contract      0x... \
 *     --rpc  http://127.0.0.1:8545 \
 *     --privkey 0x...
 *
 * All flags also readable from env (see individual bridge scripts for ENV names).
 * Optional governance flags: --flow-auth, --reputation-gate, --autonomy-bounds,
 *                            --action-permit, --identity-registry
 *
 * Ctrl-C stops all child processes.
 */

import { spawn } from 'node:child_process';
import path      from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI / env helper ──────────────────────────────────────────────────────────

function arg(flag, envVar) {
  const idx = process.argv.indexOf(flag);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : process.env[envVar];
}

// ── Common flags (forwarded to all bridges) ───────────────────────────────────

const RPC           = arg('--rpc',                   'RPC_URL')                   ?? 'http://127.0.0.1:8545';
const PRIVKEY       = arg('--privkey',               'ORACLE_PRIVATE_KEY');
const SIGNER_TYPE   = arg('--signer-type',           'SIGNER_TYPE')               ?? 'local';
const VAULT_URL     = arg('--vault-url',             'VAULT_URL');
const VAULT_ADDR    = arg('--vault-address',         'ORACLE_ADDRESS');
const FLOW_AUTH     = arg('--flow-auth',             'FLOW_AUTH_ADDRESS');
const REP_GATE      = arg('--reputation-gate',       'REPUTATION_GATE_ADDRESS');
const AUTO_BOUNDS   = arg('--autonomy-bounds',       'AUTONOMY_BOUNDS_ADDRESS');
const ACTION_PERMIT = arg('--action-permit',         'ACTION_PERMIT_ADDRESS');
const IDENTITY_REG  = arg('--identity-registry',     'IDENTITY_REGISTRY_ADDRESS');

// ── Contract addresses ────────────────────────────────────────────────────────

const ONBOARDING_REG  = arg('--onboarding-registry', 'ONBOARDING_REGISTRY_ADDRESS');
const AML_CONTRACT    = arg('--aml-contract',         'AML_CONTRACT_ADDRESS');
const CREDIT_CONTRACT = arg('--credit-contract',      'CREDIT_CONTRACT_ADDRESS');
const LEGAL_CONTRACT  = arg('--legal-contract',       'LEGAL_CONTRACT_ADDRESS');
const SETUP_CONTRACT  = arg('--setup-contract',       'SETUP_CONTRACT_ADDRESS');

// ── Bounds monitor ────────────────────────────────────────────────────────────

const BOUNDS_PORT    = arg('--bounds-port') ?? '9090';
const BOUNDS_MOCK    = process.argv.includes('--bounds-mock');

// ── Agent IDs ─────────────────────────────────────────────────────────────────

const AML_AGENT_ID      = arg('--aml-agent-id',      'AML_AGENT_ID')      ?? '0';
const CREDIT_AGENT_ID   = arg('--credit-agent-id',   'CREDIT_AGENT_ID')   ?? '1';
const LEGAL_AGENT_ID    = arg('--legal-agent-id',    'LEGAL_AGENT_ID')    ?? '3';
const ENTITY_AGENT_ID   = arg('--entity-agent-id',   'ENTITY_AGENT_ID')   ?? '4';
const ACCOUNT_AGENT_ID  = arg('--account-agent-id',  'ACCOUNT_AGENT_ID')  ?? '5';
const PRODUCT_AGENT_ID  = arg('--product-agent-id',  'PRODUCT_AGENT_ID')  ?? '6';
const HF_DOC_AGENT_ID   = arg('--hf-doc-agent-id',   'HF_DOC_AGENT_ID')   ?? '7';
const HF_CREDIT_AGENT_ID= arg('--hf-credit-agent-id','HF_CREDIT_AGENT_ID')  ?? '8';
const HF_LEGAL_AGENT_ID = arg('--hf-legal-agent-id', 'HF_LEGAL_AGENT_ID') ?? '9';

// ── Governance optional flags ─────────────────────────────────────────────────

function govFlags() {
  const flags = [];
  if (FLOW_AUTH)     { flags.push('--flow-auth',         FLOW_AUTH); }
  if (REP_GATE)      { flags.push('--reputation-gate',   REP_GATE); }
  if (AUTO_BOUNDS)   { flags.push('--autonomy-bounds',   AUTO_BOUNDS); }
  if (ACTION_PERMIT) { flags.push('--action-permit',     ACTION_PERMIT); }
  if (IDENTITY_REG)  { flags.push('--identity-registry', IDENTITY_REG); }
  if (SIGNER_TYPE !== 'local') { flags.push('--signer-type', SIGNER_TYPE); }
  if (VAULT_URL)     { flags.push('--vault-url',         VAULT_URL); }
  if (VAULT_ADDR)    { flags.push('--vault-address',     VAULT_ADDR); }
  return flags;
}

function signerFlags() {
  const flags = ['--rpc', RPC];
  if (PRIVKEY) flags.push('--privkey', PRIVKEY);
  return [...flags, ...govFlags()];
}

// ── Bridge definitions ────────────────────────────────────────────────────────

const bridges = [
  // ── Bounds monitor (always started; --mock skips on-chain calls) ───────────
  {
    name: 'bounds-monitor',
    script: 'bounds-monitor.js',
    args: [
      '--port', BOUNDS_PORT,
      '--rpc',  RPC,
      ...(PRIVKEY      ? ['--privkey',        PRIVKEY]    : []),
      ...(AUTO_BOUNDS  ? ['--autonomy-bounds', AUTO_BOUNDS]: []),
      ...(BOUNDS_MOCK || !AUTO_BOUNDS ? ['--mock'] : []),
    ],
  },
  // ── Bank side ──────────────────────────────────────────────────────────────
  AML_CONTRACT && {
    name: 'aml-bridge',
    script: 'aml-bridge.js',
    args: ['--contract', AML_CONTRACT, '--agent-id', AML_AGENT_ID, ...signerFlags()],
  },
  CREDIT_CONTRACT && {
    name: 'credit-risk-bridge',
    script: 'credit-risk-bridge.js',
    args: ['--contract', CREDIT_CONTRACT, '--agent-id', CREDIT_AGENT_ID, ...signerFlags()],
  },
  LEGAL_CONTRACT && {
    name: 'legal-bridge',
    script: 'legal-bridge.js',
    args: ['--contract', LEGAL_CONTRACT, '--agent-id', LEGAL_AGENT_ID, ...signerFlags()],
  },
  (ONBOARDING_REG && AML_CONTRACT && CREDIT_CONTRACT && LEGAL_CONTRACT) && {
    name: 'orchestrator-bridge',
    script: 'onboarding-orchestrator-bridge.js',
    args: [
      '--onboarding-registry', ONBOARDING_REG,
      '--aml-contract',        AML_CONTRACT,
      '--credit-contract',     CREDIT_CONTRACT,
      '--legal-contract',      LEGAL_CONTRACT,
      ...signerFlags(),
    ],
  },
  (ONBOARDING_REG && SETUP_CONTRACT) && {
    name: 'client-setup-bridge',
    script: 'client-setup-bridge.js',
    args: [
      '--onboarding-registry', ONBOARDING_REG,
      '--setup-contract',      SETUP_CONTRACT,
      '--entity-agent-id',     ENTITY_AGENT_ID,
      '--account-agent-id',    ACCOUNT_AGENT_ID,
      '--product-agent-id',    PRODUCT_AGENT_ID,
      ...signerFlags(),
    ],
  },
  // ── Hedge fund side ────────────────────────────────────────────────────────
  (AML_CONTRACT && CREDIT_CONTRACT) && {
    name: 'hf-document-bridge',
    script: 'hf-document-bridge.js',
    args: [
      '--aml-contract',    AML_CONTRACT,
      '--credit-contract', CREDIT_CONTRACT,
      '--agent-id',        HF_DOC_AGENT_ID,
      ...signerFlags(),
    ],
  },
  CREDIT_CONTRACT && {
    name: 'hf-credit-negotiator-bridge',
    script: 'hf-credit-negotiator-bridge.js',
    args: ['--credit-contract', CREDIT_CONTRACT, '--agent-id', HF_CREDIT_AGENT_ID, ...signerFlags()],
  },
  LEGAL_CONTRACT && {
    name: 'hf-legal-bridge',
    script: 'hf-legal-bridge.js',
    args: ['--legal-contract', LEGAL_CONTRACT, '--agent-id', HF_LEGAL_AGENT_ID, ...signerFlags()],
  },
].filter(Boolean);

// ── Spawn ─────────────────────────────────────────────────────────────────────

const children = [];

for (const { name, script, args } of bridges) {
  const scriptPath = path.join(__dirname, script);
  console.log(`[launch-bridges] Starting ${name}`);

  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('exit', (code, signal) =>
    console.log(`[launch-bridges] ${name} exited (code=${code} signal=${signal})`)
  );

  children.push({ name, child });
}

console.log(`\n[launch-bridges] ${children.length} bridge(s) running. Ctrl-C to stop all.\n`);

function shutdown() {
  console.log('\n[launch-bridges] Shutting down…');
  for (const { name, child } of children) {
    console.log(`[launch-bridges]   stopping ${name}`);
    child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
