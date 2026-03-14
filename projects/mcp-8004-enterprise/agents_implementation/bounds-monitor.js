/**
 * bounds-monitor.js
 *
 * Off-chain autonomy bounds monitor — Layers 6 and 7.
 *
 * Reads autonomy_bounds from all MCP specs, tracks sliding-window metrics per
 * tool, and enforces two policies that cannot be checked on-chain because they
 * are time-relative:
 *
 *   Layer 6 – error/success rate violations  (anomaly + performance signals)
 *   Layer 7 – burst rate + response timeout   (flow signal)
 *
 * On violation:
 *   1. Writes bounds-state.json — MCP servers read this on every request to
 *      surface x_suspended / x_suspension_reason in tools/list responses.
 *   2. (Optional) Calls disableTool() on AutonomyBoundsRegistry on-chain so
 *      oracle bridges are also blocked before submitting fulfilment transactions.
 *
 * On recovery (metrics return within bounds):
 *   Both state file and on-chain entry are re-enabled automatically.
 *
 * HTTP control API (default port 9090):
 *   POST /report   { toolName, success, latencyMs, agentId? }
 *                   → Report the outcome of a tool call.
 *   GET  /state    → Current bounds-state (same object written to bounds-state.json).
 *   GET  /metrics  → Per-tool sliding-window statistics and burst counts.
 *   POST /reset    { toolName }  → Force-enable a tool (testing / operator override).
 *
 * CLI flags (all optional when --mock is set):
 *   --rpc <url>              JSON-RPC endpoint  (default: http://127.0.0.1:8545)
 *   --privkey <hex>          Signer private key for on-chain calls
 *   --autonomy-bounds <addr> AutonomyBoundsRegistry contract address
 *   --agent-id <n>           Default agentId for all tools (mock / single-agent mode)
 *   --agent-ids <json>       JSON map of toolName → agentId, overrides --agent-id
 *   --port <n>               HTTP port for the control API  (default: 9090)
 *   --state-path <path>      Output path for bounds-state.json
 *   --specs-dir <path>       Directory containing *.mcp.json files
 *   --mock                   Skip on-chain calls entirely
 */

import http   from 'node:http';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI / env helpers ─────────────────────────────────────────────────────────

function arg(flag, envVar) {
  const idx = process.argv.indexOf(flag);
  return (idx !== -1 && process.argv[idx + 1]) ? process.argv[idx + 1] : (envVar ? process.env[envVar] : undefined);
}

function flag(name) { return process.argv.includes(name); }

// ── On-chain ABI ──────────────────────────────────────────────────────────────

const AUTONOMY_BOUNDS_ABI = [
  'function disableTool(uint256 agentId, bytes32 toolHash, string calldata reason) external',
  'function enableTool(uint256 agentId, bytes32 toolHash) external',
  'function isToolEnabled(uint256 agentId, bytes32 toolHash) view returns (bool)',
];

// ── Sliding window ────────────────────────────────────────────────────────────

class SlidingWindow {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this._buf    = []; // boolean: true = success
  }

  push(success) {
    if (this._buf.length >= this.maxSize) this._buf.shift();
    this._buf.push(success);
  }

  get size()           { return this._buf.length; }
  get successCount()   { return this._buf.filter(Boolean).length; }
  get errorCount()     { return this._buf.length - this.successCount; }
  get errorRatePct()   { return this.size === 0 ? 0   : (this.errorCount   / this.size) * 100; }
  get successRatePct() { return this.size === 0 ? 100 : (this.successCount / this.size) * 100; }

  stats() {
    return {
      size: this.size,
      successCount: this.successCount,
      errorCount: this.errorCount,
      errorRatePct: +this.errorRatePct.toFixed(1),
      successRatePct: +this.successRatePct.toFixed(1),
    };
  }
}

// ── Burst tracker ─────────────────────────────────────────────────────────────

class BurstTracker {
  constructor(maxPerMinute) {
    this.maxPerMinute = maxPerMinute;
    this._ts = [];
  }

  _prune() { const now = Date.now(); this._ts = this._ts.filter(t => now - t < 60_000); }

  record()              { this._prune(); this._ts.push(Date.now()); }
  get countPerMinute()  { this._prune(); return this._ts.length; }
  isExceeded()          { return this.countPerMinute > this.maxPerMinute; }
}

// ── Spec loading ──────────────────────────────────────────────────────────────

/**
 * Walk all *.mcp.json files and collect per-tool autonomy_bounds configs.
 * Returns Map<toolName, { specFile, bounds: { anomaly?, performance?, flow? } }>
 */
function loadSpecs(specsDir) {
  const toolBounds = new Map();

  for (const f of fs.readdirSync(specsDir).filter(f => f.endsWith('.mcp.json'))) {
    const spec = JSON.parse(fs.readFileSync(path.join(specsDir, f), 'utf8'));
    for (const tool of (spec.tools ?? [])) {
      if (tool.autonomy_bounds && Object.keys(tool.autonomy_bounds).length > 0) {
        toolBounds.set(tool.name, { specFile: f, bounds: tool.autonomy_bounds });
      }
    }
  }

  return toolBounds;
}

// ── Per-tool runtime state ────────────────────────────────────────────────────

/**
 * Build the in-memory state map from loaded spec bounds.
 * Returns Map<toolName, ToolState>
 */
function initToolStates(toolBounds, defaultAgentId, agentIdOverrides) {
  const states = new Map();

  for (const [toolName, { specFile, bounds }] of toolBounds) {
    const agentId = BigInt(agentIdOverrides[toolName] ?? agentIdOverrides['*'] ?? defaultAgentId ?? '0');

    states.set(toolName, {
      specFile,
      bounds,
      agentId,
      toolHash: ethers.keccak256(ethers.toUtf8Bytes(toolName)),

      // Sliding windows — sized from spec, or a sensible default.
      anomalyWindow:     new SlidingWindow(bounds.anomaly?.window_requests     ?? 50),
      performanceWindow: new SlidingWindow(bounds.performance?.window_requests ?? 100),
      burstTracker:      bounds.flow?.max_requests_per_minute
                           ? new BurstTracker(bounds.flow.max_requests_per_minute) : null,

      responseTimeoutMs: bounds.flow?.response_timeout_seconds
                           ? bounds.flow.response_timeout_seconds * 1000 : null,

      // Current suspension state.
      enabled:       true,
      disabledReason: null,
      disabledAt:    null,
    });
  }

  return states;
}

// ── Threshold evaluation ──────────────────────────────────────────────────────

/**
 * Check all bounds for a tool.
 * Returns { violated: boolean, reason: string | null }
 */
function evaluateThresholds(state, latencyMs) {
  const { bounds, anomalyWindow, performanceWindow, burstTracker, responseTimeoutMs } = state;

  if (bounds.anomaly) {
    const { max_error_rate_pct, window_requests } = bounds.anomaly;
    if (anomalyWindow.size >= window_requests && anomalyWindow.errorRatePct > max_error_rate_pct) {
      return {
        violated: true,
        reason: `error rate ${anomalyWindow.errorRatePct.toFixed(1)}% exceeded threshold ${max_error_rate_pct}% `
              + `over last ${anomalyWindow.size} requests`,
      };
    }
  }

  if (bounds.performance) {
    const { min_success_rate_pct, window_requests } = bounds.performance;
    if (performanceWindow.size >= window_requests && performanceWindow.successRatePct < min_success_rate_pct) {
      return {
        violated: true,
        reason: `success rate ${performanceWindow.successRatePct.toFixed(1)}% below threshold ${min_success_rate_pct}% `
              + `over last ${performanceWindow.size} requests`,
      };
    }
  }

  if (bounds.flow) {
    if (burstTracker && burstTracker.isExceeded()) {
      return {
        violated: true,
        reason: `burst rate ${burstTracker.countPerMinute} req/min exceeded limit ${bounds.flow.max_requests_per_minute}`,
      };
    }
    if (latencyMs != null && responseTimeoutMs != null && latencyMs > responseTimeoutMs) {
      return {
        violated: true,
        reason: `response timeout: ${latencyMs}ms exceeded limit ${responseTimeoutMs}ms`,
      };
    }
  }

  return { violated: false, reason: null };
}

/**
 * Check whether a disabled tool's metrics have recovered within bounds.
 * Returns true if all tracked signals are now within thresholds.
 */
function hasRecovered(state) {
  const { bounds, anomalyWindow, performanceWindow, burstTracker } = state;

  if (bounds.anomaly) {
    const { max_error_rate_pct, window_requests } = bounds.anomaly;
    if (anomalyWindow.size >= window_requests && anomalyWindow.errorRatePct > max_error_rate_pct) return false;
  }

  if (bounds.performance) {
    const { min_success_rate_pct, window_requests } = bounds.performance;
    if (performanceWindow.size >= window_requests && performanceWindow.successRatePct < min_success_rate_pct) return false;
  }

  if (bounds.flow?.max_requests_per_minute && burstTracker && burstTracker.isExceeded()) return false;

  return true;
}

// ── State persistence ─────────────────────────────────────────────────────────

function persistState(toolStates, statePath) {
  const out = {};
  for (const [toolName, s] of toolStates) {
    out[toolName] = {
      enabled:        s.enabled,
      disabledReason: s.disabledReason ?? null,
      disabledAt:     s.disabledAt    ?? null,
    };
  }
  fs.writeFileSync(statePath, JSON.stringify(out, null, 2));
}

// ── On-chain write (optional) ─────────────────────────────────────────────────

async function onChainDisable(contract, agentId, toolHash, reason, label) {
  if (!contract) return;
  try {
    const tx = await contract.disableTool(agentId, toolHash, reason);
    console.log(`[${label}] disableTool tx=${tx.hash}`);
  } catch (err) {
    console.warn(`[${label}] disableTool failed: ${err.message}`);
  }
}

async function onChainEnable(contract, agentId, toolHash, label) {
  if (!contract) return;
  try {
    const tx = await contract.enableTool(agentId, toolHash);
    console.log(`[${label}] enableTool tx=${tx.hash}`);
  } catch (err) {
    console.warn(`[${label}] enableTool failed: ${err.message}`);
  }
}

// ── Core: process a tool call report ─────────────────────────────────────────

async function processReport({ toolName, success, latencyMs, agentId: reportAgentId }, toolStates, statePath, contract) {
  const state = toolStates.get(toolName);
  if (!state) {
    console.warn(`[bounds-monitor] unknown tool in report: ${toolName}`);
    return { ok: false, message: `unknown tool: ${toolName}` };
  }

  // Record into sliding windows.
  state.anomalyWindow.push(success);
  state.performanceWindow.push(success);
  if (state.burstTracker) state.burstTracker.record();

  const agentId = reportAgentId != null ? BigInt(reportAgentId) : state.agentId;
  const label   = toolName;

  if (state.enabled) {
    const { violated, reason } = evaluateThresholds(state, latencyMs);
    if (violated) {
      console.warn(`[${label}] THRESHOLD VIOLATED — suspending: ${reason}`);
      state.enabled        = false;
      state.disabledReason = reason;
      state.disabledAt     = Date.now();
      persistState(toolStates, statePath);
      await onChainDisable(contract, agentId, state.toolHash, reason, label);
      return { ok: true, action: 'suspended', reason };
    }
  } else {
    // Tool is suspended — check recovery.
    if (hasRecovered(state)) {
      console.log(`[${label}] RECOVERED — re-enabling`);
      state.enabled        = true;
      state.disabledReason = null;
      state.disabledAt     = null;
      persistState(toolStates, statePath);
      await onChainEnable(contract, agentId, state.toolHash, label);
      return { ok: true, action: 'recovered' };
    }
  }

  return { ok: true, action: 'recorded', suspended: !state.enabled };
}

// ── HTTP control API ──────────────────────────────────────────────────────────

function startHttpServer(port, toolStates, statePath, contract) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    res.setHeader('Content-Type', 'application/json');

    // GET /state
    if (req.method === 'GET' && url.pathname === '/state') {
      const out = {};
      for (const [k, s] of toolStates) {
        out[k] = { enabled: s.enabled, disabledReason: s.disabledReason, disabledAt: s.disabledAt };
      }
      res.writeHead(200); res.end(JSON.stringify(out, null, 2));
      return;
    }

    // GET /metrics
    if (req.method === 'GET' && url.pathname === '/metrics') {
      const out = {};
      for (const [toolName, s] of toolStates) {
        out[toolName] = {
          enabled:     s.enabled,
          agentId:     s.agentId.toString(),
          specFile:    s.specFile,
          anomaly:     s.bounds.anomaly    ? { ...s.anomalyWindow.stats(),     threshold: s.bounds.anomaly.max_error_rate_pct + '%' } : null,
          performance: s.bounds.performance ? { ...s.performanceWindow.stats(), threshold: s.bounds.performance.min_success_rate_pct + '%' } : null,
          burst:       s.burstTracker      ? { countPerMinute: s.burstTracker.countPerMinute, limit: s.bounds.flow.max_requests_per_minute } : null,
          responseTimeoutMs: s.responseTimeoutMs,
        };
      }
      res.writeHead(200); res.end(JSON.stringify(out, null, 2));
      return;
    }

    // POST /report
    if (req.method === 'POST' && url.pathname === '/report') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', async () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return; }

        const { toolName, success, latencyMs, agentId } = parsed;
        if (!toolName || success === undefined) {
          res.writeHead(400); res.end(JSON.stringify({ error: 'toolName and success are required' })); return;
        }

        const result = await processReport({ toolName, success: !!success, latencyMs, agentId }, toolStates, statePath, contract);
        res.writeHead(200); res.end(JSON.stringify(result));
      });
      return;
    }

    // POST /reset
    if (req.method === 'POST' && url.pathname === '/reset') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', async () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return; }

        const { toolName } = parsed;
        const state = toolStates.get(toolName);
        if (!state) { res.writeHead(404); res.end(JSON.stringify({ error: `unknown tool: ${toolName}` })); return; }

        state.enabled        = true;
        state.disabledReason = null;
        state.disabledAt     = null;
        persistState(toolStates, statePath);
        await onChainEnable(contract, state.agentId, state.toolHash, toolName);
        console.log(`[${toolName}] FORCE-RESET by operator`);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, action: 'reset', toolName }));
      });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ error: 'not found' }));
  });

  server.listen(port, () => console.log(`[bounds-monitor] HTTP API → http://localhost:${port}`));
  return server;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const MOCK       = flag('--mock');
  const PORT       = parseInt(arg('--port') ?? '9090', 10);
  const RPC_URL    = arg('--rpc', 'RPC_URL')                 ?? 'http://127.0.0.1:8545';
  const PRIV_KEY   = arg('--privkey', 'ORACLE_PRIVATE_KEY');
  const BOUNDS_ADDR= arg('--autonomy-bounds', 'AUTONOMY_BOUNDS_ADDRESS');
  const STATE_PATH = arg('--state-path')                     ?? path.resolve(__dirname, 'bounds-state.json');
  const SPECS_DIR  = arg('--specs-dir')                      ?? path.resolve(__dirname, '..', 'agents', 'mcp');
  const DEF_AGENT  = arg('--agent-id')                       ?? '0';
  const AGENT_IDS  = arg('--agent-ids') ? JSON.parse(arg('--agent-ids')) : {};

  console.log('[bounds-monitor] starting');
  console.log(`[bounds-monitor] specs-dir  : ${SPECS_DIR}`);
  console.log(`[bounds-monitor] state-path : ${STATE_PATH}`);
  console.log(`[bounds-monitor] on-chain   : ${MOCK ? 'disabled (--mock)' : (BOUNDS_ADDR ?? 'disabled (no address)')}`);

  // Load specs and initialise per-tool state.
  const toolBounds = loadSpecs(SPECS_DIR);
  console.log(`[bounds-monitor] tools with autonomy_bounds: ${[...toolBounds.keys()].join(', ')}`);

  const toolStates = initToolStates(toolBounds, DEF_AGENT, AGENT_IDS);

  // Write an initial state file so MCP servers start cleanly.
  persistState(toolStates, STATE_PATH);
  console.log(`[bounds-monitor] bounds-state.json written (${toolStates.size} tools)`);

  // Optional on-chain contract.
  let contract = null;
  if (!MOCK && BOUNDS_ADDR && PRIV_KEY) {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet   = new ethers.Wallet(PRIV_KEY, provider);
    contract       = new ethers.Contract(BOUNDS_ADDR, AUTONOMY_BOUNDS_ABI, wallet);
    console.log(`[bounds-monitor] AutonomyBoundsRegistry @ ${BOUNDS_ADDR}`);
  } else if (!MOCK && BOUNDS_ADDR) {
    console.warn('[bounds-monitor] --autonomy-bounds set but --privkey missing — on-chain calls disabled');
  }

  // Start HTTP control API.
  startHttpServer(PORT, toolStates, STATE_PATH, contract);

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT',  () => process.exit(0));
}

main().catch(err => { console.error('[bounds-monitor]', err); process.exit(1); });
