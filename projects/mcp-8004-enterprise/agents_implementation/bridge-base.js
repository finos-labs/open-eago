/**
 * bridge-base.js
 *
 * Shared bootstrap for all onboarding oracle bridges.
 * Parses common CLI flags, builds provider + signer + optional governance
 * contract handles, validates the agent card hash at startup.
 */

import { ethers } from 'ethers';
import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSigner } from './vault-signer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI / env helper ──────────────────────────────────────────────────────────

export function arg(flag, envVar) {
  const idx = process.argv.indexOf(flag);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : process.env[envVar];
}

// ── Governance ABIs ───────────────────────────────────────────────────────────

const FLOW_AUTH_ABI = [
  'function isAuthorized(bytes32 traceId, uint256 agentId, bytes32 capability) view returns (bool)',
];
const REPUTATION_GATE_ABI = [
  'function meetsThreshold(uint256 agentId, bytes32 capability) view returns (bool)',
];
const AUTONOMY_BOUNDS_ABI = [
  'function isToolEnabled(uint256 agentId, bytes32 toolHash) view returns (bool)',
];
const ACTION_PERMIT_ABI = [
  'function validateAction(bytes32 flowId, uint256 agentId, bytes32 actionType) view returns (bool)',
];
const IDENTITY_REGISTRY_ABI = [
  'function getCardHash(uint256 agentId) view returns (bytes32)',
];

// ── Governance preflight ──────────────────────────────────────────────────────

/**
 * Run all enabled governance pre-flight checks before spending gas.
 * Returns true if all pass; false (with a console.warn) if any fail.
 */
export async function governancePreflight(label, { flowId, agentId, capability, toolHash, contracts }) {
  const { flowAuth, reputationGate, autonomyBounds, actionPermit } = contracts;
  if (flowAuth) {
    const ok = await flowAuth.isAuthorized(flowId, agentId, capability);
    if (!ok) { console.warn(`[${label}] [${flowId}] flow-auth denied agentId=${agentId}`); return false; }
  }
  if (reputationGate) {
    const ok = await reputationGate.meetsThreshold(agentId, capability);
    if (!ok) { console.warn(`[${label}] [${flowId}] reputation gate failed agentId=${agentId}`); return false; }
  }
  if (autonomyBounds) {
    const ok = await autonomyBounds.isToolEnabled(agentId, toolHash);
    if (!ok) { console.warn(`[${label}] [${flowId}] autonomy bounds revoked tool=${toolHash}`); return false; }
  }
  if (actionPermit) {
    const ok = await actionPermit.validateAction(flowId, agentId, toolHash);
    if (!ok) { console.warn(`[${label}] [${flowId}] action permit denied tool=${toolHash}`); return false; }
  }
  return true;
}

// ── Call MCP tool ─────────────────────────────────────────────────────────────

export async function callMcpTool(endpoint, toolName, args, traceId) {
  const body = {
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: { ...args, trace_id: traceId } },
  };
  const res  = await fetch(`${endpoint}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trace-Id': traceId },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`MCP error from ${endpoint} tool=${toolName}: ${JSON.stringify(json.error)}`);
  const raw = json?.result?.content?.[0]?.text;
  if (!raw) throw new Error(`Empty MCP response from ${endpoint} tool=${toolName}`);
  return JSON.parse(raw);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Parse common flags, build provider / signer / governance contracts.
 * Returns { provider, wallet, signerAddress, contracts, agentId, cardRaw }.
 */
export async function bootstrapBridge(label, {
  contractFlag, contractEnv, agentIdEnv, cardGlob,
}) {
  const RPC_URL            = arg('--rpc',              'RPC_URL')              ?? 'http://127.0.0.1:8545';
  const PRIVATE_KEY        = arg('--privkey',          'ORACLE_PRIVATE_KEY');
  const SIGNER_TYPE        = arg('--signer-type',      'SIGNER_TYPE')          ?? 'local';
  const VAULT_URL          = arg('--vault-url',        'VAULT_URL');
  const VAULT_ADDRESS      = arg('--vault-address',    'ORACLE_ADDRESS');
  const FLOW_AUTH_ADDR     = arg('--flow-auth',        'FLOW_AUTH_ADDRESS');
  const REPUTATION_ADDR    = arg('--reputation-gate',  'REPUTATION_GATE_ADDRESS');
  const AUTONOMY_ADDR      = arg('--autonomy-bounds',  'AUTONOMY_BOUNDS_ADDRESS');
  const ACTION_PERMIT_ADDR = arg('--action-permit',    'ACTION_PERMIT_ADDRESS');
  const IDENTITY_ADDR      = arg('--identity-registry','IDENTITY_REGISTRY_ADDRESS');

  const CONTRACT_ADDRESS = arg(contractFlag, contractEnv);
  const AGENT_ID         = BigInt(arg('--agent-id', agentIdEnv) ?? '0');

  if (!CONTRACT_ADDRESS) {
    console.error(`[${label}] Missing ${contractFlag} / ${contractEnv}`);
    process.exit(1);
  }
  if (SIGNER_TYPE === 'local' && !PRIVATE_KEY) {
    console.error(`[${label}] Missing --privkey / ORACLE_PRIVATE_KEY`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = createSigner({ type: SIGNER_TYPE, privateKey: PRIVATE_KEY, vaultUrl: VAULT_URL, address: VAULT_ADDRESS }, provider);
  const signerAddress = await wallet.getAddress();

  const contracts = {
    flowAuth:       FLOW_AUTH_ADDR     ? new ethers.Contract(FLOW_AUTH_ADDR,     FLOW_AUTH_ABI,     provider) : null,
    reputationGate: REPUTATION_ADDR    ? new ethers.Contract(REPUTATION_ADDR,    REPUTATION_GATE_ABI, provider) : null,
    autonomyBounds: AUTONOMY_ADDR      ? new ethers.Contract(AUTONOMY_ADDR,      AUTONOMY_BOUNDS_ABI, provider) : null,
    actionPermit:   ACTION_PERMIT_ADDR ? new ethers.Contract(ACTION_PERMIT_ADDR, ACTION_PERMIT_ABI, provider) : null,
  };

  // Card hash startup check
  let cardRaw = null;
  if (IDENTITY_ADDR && cardGlob) {
    const identityRegistry = new ethers.Contract(IDENTITY_ADDR, IDENTITY_REGISTRY_ABI, provider);
    const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');
    const cardFile = fs.readdirSync(AGENTS_DIR)
      .filter(f => f.endsWith('.json'))
      .find(f => cardGlob(f));
    if (cardFile) {
      cardRaw = fs.readFileSync(path.join(AGENTS_DIR, cardFile));
      const localHash   = ethers.keccak256(cardRaw);
      const onChainHash = await identityRegistry.getCardHash(AGENT_ID);
      if (onChainHash !== ethers.ZeroHash && onChainHash !== localHash) {
        console.warn(`[${label}] WARNING card hash mismatch agentId=${AGENT_ID} local=${localHash} on-chain=${onChainHash}`);
      } else {
        console.log(`[${label}] Card hash OK agentId=${AGENT_ID}: ${localHash}`);
      }
    }
  }

  console.log(`[${label}] RPC        : ${RPC_URL}`);
  console.log(`[${label}] Contract   : ${CONTRACT_ADDRESS}`);
  console.log(`[${label}] Signer     : ${SIGNER_TYPE} (${signerAddress})`);
  console.log(`[${label}] AgentId    : ${AGENT_ID}`);
  console.log(`[${label}] FlowAuth   : ${FLOW_AUTH_ADDR    ?? '(disabled)'}`);
  console.log(`[${label}] RepGate    : ${REPUTATION_ADDR   ?? '(disabled)'}`);
  console.log(`[${label}] AutoBounds : ${AUTONOMY_ADDR     ?? '(disabled)'}`);
  console.log(`[${label}] ActionPerm : ${ACTION_PERMIT_ADDR ?? '(disabled)'}`);

  return { provider, wallet, signerAddress, contracts, agentId: AGENT_ID, cardRaw, CONTRACT_ADDRESS };
}
