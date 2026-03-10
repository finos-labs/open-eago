/**
 * audit-exporter.js  [P3b — Regulatory Audit Exporter]
 *
 * Per-institution off-chain service that indexes ERC-8004 chain events into a
 * queryable in-memory store and exposes a REST API for compliance tooling.
 *
 * Architecture:
 *   - Connects to the consortium RPC node.
 *   - Subscribes to events from all registry and oracle contracts.
 *   - Filters events to those involving the institution's own agents
 *     (identified by agentIds registered under the institution's participantId).
 *   - Stores indexed records in-memory (extend with Postgres/Elasticsearch as needed).
 *   - Exposes GET endpoints for querying traces, agent events, and revocations.
 *
 * Usage:
 *   node agents_implementation/audit-exporter.js \
 *     --rpc          http://127.0.0.1:8545 \
 *     --participant  <bytes32-participantId> \
 *     --identity     <IdentityRegistry address> \
 *     --trace-log    <ExecutionTraceLog address> \
 *     --participant-registry <ParticipantRegistry address> \
 *     --autonomy-bounds      <AutonomyBoundsRegistry address> \
 *     --action-permit        <ActionPermitRegistry address> \
 *     --port         4000
 *
 * ENV equivalents: RPC_URL, PARTICIPANT_ID, IDENTITY_REGISTRY_ADDRESS,
 *   TRACE_LOG_ADDRESS, PARTICIPANT_REGISTRY_ADDRESS,
 *   AUTONOMY_BOUNDS_ADDRESS, ACTION_PERMIT_ADDRESS, AUDIT_EXPORTER_PORT
 */

import { ethers }  from 'ethers';
import express     from 'express';
import { arg }     from './bridge-base.js';

const LABEL = 'audit-exporter';

// ── CLI / env ─────────────────────────────────────────────────────────────────

const RPC_URL          = arg('--rpc',                'RPC_URL')                   ?? 'http://127.0.0.1:8545';
const PARTICIPANT_ID   = arg('--participant',        'PARTICIPANT_ID');
const IDENTITY_ADDR    = arg('--identity',           'IDENTITY_REGISTRY_ADDRESS');
const TRACE_LOG_ADDR   = arg('--trace-log',          'TRACE_LOG_ADDRESS');
const PART_REG_ADDR    = arg('--participant-registry','PARTICIPANT_REGISTRY_ADDRESS');
const BOUNDS_ADDR      = arg('--autonomy-bounds',    'AUTONOMY_BOUNDS_ADDRESS');
const ACTION_PERMIT_ADDR = arg('--action-permit',    'ACTION_PERMIT_ADDRESS');
const PORT             = Number(arg('--port',        'AUDIT_EXPORTER_PORT') ?? '4000');

if (!PARTICIPANT_ID) { console.error(`[${LABEL}] --participant required`); process.exit(1); }
if (!IDENTITY_ADDR)  { console.error(`[${LABEL}] --identity required`);    process.exit(1); }

// ── ABIs (event-only fragments) ───────────────────────────────────────────────

const IDENTITY_ABI = [
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event OracleAddressSet(uint256 indexed agentId, address indexed oracleAddress, address indexed setBy)',
  'event CardHashSet(uint256 indexed agentId, bytes32 indexed cardHash, address indexed setBy)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
];

const TRACE_LOG_ABI = [
  'event HopRecorded(bytes32 indexed traceId, address indexed callingOracle, uint256 indexed agentId, string actionName, uint256 timestamp)',
];

const BOUNDS_ABI = [
  'event ToolDisabled(bytes32 indexed toolHash, uint256 indexed agentId, string reason, uint256 timestamp)',
  'event ToolEnabled(bytes32 indexed toolHash, uint256 indexed agentId, uint256 timestamp)',
];

const ACTION_PERMIT_ABI = [
  'event ActionPermitGranted(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, uint8 tier)',
  'event ActionPermitApproved(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType, address approver)',
  'event ActionPermitRevoked(bytes32 indexed flowId, uint256 indexed agentId, bytes32 actionType)',
];

// ── Index store ───────────────────────────────────────────────────────────────
// Extend with Postgres/Elasticsearch for production deployments.

const store = {
  /** agentId (string) → array of { event, args, block, tx } */
  byAgent: new Map(),
  /** traceId (hex) → array of hop records */
  byTrace: new Map(),
  /** revocations: array of { agentId, toolHash, reason, block, tx } */
  revocations: [],
  /** actionBlocks: array of { flowId, agentId, actionType, block, tx } */
  actionBlocks: [],
};

function recordForAgent(agentId, entry) {
  const key = agentId.toString();
  if (!store.byAgent.has(key)) store.byAgent.set(key, []);
  store.byAgent.get(key).push(entry);
}

function recordHop(traceId, hop) {
  if (!store.byTrace.has(traceId)) store.byTrace.set(traceId, []);
  store.byTrace.get(traceId).push(hop);
}

// ── Institution agent set ─────────────────────────────────────────────────────
// Populated at startup and updated on Registered events.

const institutionAgents = new Set(); // Set<bigint>

async function loadInstitutionAgents(identity) {
  // Scan all Registered events; keep those whose "participantId" metadata
  // matches our PARTICIPANT_ID.
  const filter = identity.filters.Registered();
  const events = await identity.queryFilter(filter);

  for (const ev of events) {
    const agentId = ev.args.agentId;
    try {
      const pidBytes = await identity.getMetadata(agentId, 'participantId');
      if (pidBytes && pidBytes.length >= 32) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32'], pidBytes)[0];
        if (decoded === PARTICIPANT_ID) institutionAgents.add(agentId);
      }
    } catch { /* agent has no participantId metadata */ }
  }
  console.log(`[${LABEL}] Institution agents loaded: ${institutionAgents.size}`);
}

function isOurAgent(agentId) {
  return institutionAgents.has(BigInt(agentId));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const identity = new ethers.Contract(IDENTITY_ADDR, IDENTITY_ABI, provider);

  await loadInstitutionAgents(identity);

  // Watch new registrations.
  identity.on('Registered', async (agentId, agentURI, owner, ev) => {
    try {
      const pidBytes = await identity.getMetadata(agentId, 'participantId');
      if (pidBytes && pidBytes.length >= 32) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32'], pidBytes)[0];
        if (decoded === PARTICIPANT_ID) {
          institutionAgents.add(agentId);
          recordForAgent(agentId, { event: 'Registered', agentURI, owner,
            block: ev.blockNumber, tx: ev.transactionHash });
          console.log(`[${LABEL}] +agent ${agentId} registered`);
        }
      }
    } catch { /* skip */ }
  });

  identity.on('OracleAddressSet', (agentId, oracleAddress, setBy, ev) => {
    if (!isOurAgent(agentId)) return;
    recordForAgent(agentId, { event: 'OracleAddressSet', oracleAddress, setBy,
      block: ev.blockNumber, tx: ev.transactionHash });
  });

  identity.on('CardHashSet', (agentId, cardHash, setBy, ev) => {
    if (!isOurAgent(agentId)) return;
    recordForAgent(agentId, { event: 'CardHashSet', cardHash, setBy,
      block: ev.blockNumber, tx: ev.transactionHash });
  });

  // ExecutionTraceLog.
  if (TRACE_LOG_ADDR) {
    const traceLog = new ethers.Contract(TRACE_LOG_ADDR, TRACE_LOG_ABI, provider);
    traceLog.on('HopRecorded', (traceId, callingOracle, agentId, actionName, timestamp, ev) => {
      if (!isOurAgent(agentId)) return;
      const hop = {
        agentId: agentId.toString(), callingOracle, actionName,
        timestamp: timestamp.toString(), block: ev.blockNumber, tx: ev.transactionHash,
      };
      recordHop(traceId, hop);
      recordForAgent(agentId, { event: 'HopRecorded', traceId, ...hop });
    });
    console.log(`[${LABEL}] Watching ExecutionTraceLog at ${TRACE_LOG_ADDR}`);
  }

  // AutonomyBoundsRegistry — tool revocations.
  if (BOUNDS_ADDR) {
    const bounds = new ethers.Contract(BOUNDS_ADDR, BOUNDS_ABI, provider);
    bounds.on('ToolDisabled', (toolHash, agentId, reason, timestamp, ev) => {
      if (!isOurAgent(agentId)) return;
      const rec = { agentId: agentId.toString(), toolHash, reason,
        timestamp: timestamp.toString(), block: ev.blockNumber, tx: ev.transactionHash };
      store.revocations.push(rec);
      recordForAgent(agentId, { event: 'ToolDisabled', ...rec });
      console.log(`[${LABEL}] ToolDisabled agent=${agentId} toolHash=${toolHash}`);
    });
    bounds.on('ToolEnabled', (toolHash, agentId, timestamp, ev) => {
      if (!isOurAgent(agentId)) return;
      recordForAgent(agentId, { event: 'ToolEnabled', agentId: agentId.toString(),
        toolHash, block: ev.blockNumber, tx: ev.transactionHash });
    });
    console.log(`[${LABEL}] Watching AutonomyBoundsRegistry at ${BOUNDS_ADDR}`);
  }

  // ActionPermitRegistry.
  if (ACTION_PERMIT_ADDR) {
    const actionPermit = new ethers.Contract(ACTION_PERMIT_ADDR, ACTION_PERMIT_ABI, provider);
    const logAction = (name) => (flowId, agentId, actionType, extra, ev) => {
      if (!isOurAgent(agentId)) return;
      const rec = { flowId, agentId: agentId.toString(), actionType, ...extra,
        block: ev.blockNumber, tx: ev.transactionHash };
      if (name === 'ActionPermitRevoked') store.actionBlocks.push(rec);
      recordForAgent(agentId, { event: name, ...rec });
    };
    actionPermit.on('ActionPermitGranted',  logAction('ActionPermitGranted'));
    actionPermit.on('ActionPermitApproved', logAction('ActionPermitApproved'));
    actionPermit.on('ActionPermitRevoked',  logAction('ActionPermitRevoked'));
    console.log(`[${LABEL}] Watching ActionPermitRegistry at ${ACTION_PERMIT_ADDR}`);
  }

  console.log(`[${LABEL}] Indexing events for participant ${PARTICIPANT_ID}`);

  // ── REST API ────────────────────────────────────────────────────────────────

  const app = express();

  /** GET /agents — list all institution agent IDs */
  app.get('/agents', (_req, res) => {
    res.json([...institutionAgents].map(id => id.toString()));
  });

  /** GET /agents/:agentId/events — full event history for an agent */
  app.get('/agents/:agentId/events', (req, res) => {
    const events = store.byAgent.get(req.params.agentId) ?? [];
    res.json(events);
  });

  /** GET /traces/:traceId — ordered hop log for a trace */
  app.get('/traces/:traceId', (req, res) => {
    const hops = store.byTrace.get(req.params.traceId) ?? [];
    res.json(hops);
  });

  /** GET /revocations — all tool revocations for institution agents */
  app.get('/revocations', (_req, res) => {
    res.json(store.revocations);
  });

  /** GET /action-blocks — all ActionPermit revocations for institution agents */
  app.get('/action-blocks', (_req, res) => {
    res.json(store.actionBlocks);
  });

  /** GET /health */
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      participant: PARTICIPANT_ID,
      agentCount: institutionAgents.size,
      traceCount: store.byTrace.size,
    });
  });

  app.listen(PORT, () => {
    console.log(`[${LABEL}] REST API listening on port ${PORT}`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
