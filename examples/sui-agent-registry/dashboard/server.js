/**
 * SUI A2A Registry — Live Monitoring Dashboard
 * Express backend that proxies SUI JSON-RPC calls and serves the frontend.
 */

import express from "express";
import { createServer } from "http";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Registry constants (mirrored from sui_rpc.py) ───────────────────────────

const CONFIG = {
  rpcUrl:       "https://fullnode.testnet.sui.io:443",
  network:      "testnet",
  packageId:    "0xe7e6bfd3bfb1bb93accb07da8f3bfa95ed7aa70c231dc3d784a7052e1d336775",
  identityId:   "0xa7ab6d000862a7b30ed1b2e7d02baa131fa9530a9d4c67b39a1a1804b5b21193",
  reputationId: "0x8b3507234e8d98d235e395f0a42f6ea3e803d4524ff4e48539fb6fc6c79b3ac7",
  validationId: "0xf9527c669e6a0952053b0cfa91fe3429b2f39c8844f148b1e78132141f049048",
  clockId:      "0x6",
};

// ─── SUI RPC helpers ─────────────────────────────────────────────────────────

async function rpc(method, params = []) {
  const res = await fetch(CONFIG.rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function getObject(objectId) {
  const result = await rpc("sui_getObject", [objectId, { showContent: true }]);
  if (result?.error) throw new Error(`Object not found: ${objectId}`);
  return result?.data;
}

async function getDynamicFields(parentId, cursor = null, limit = 50) {
  return rpc("suix_getDynamicFields", [parentId, cursor, limit]);
}

async function queryEvents(eventType, cursor = null, limit = 50, descending = true) {
  return rpc("suix_queryEvents", [
    { MoveEventType: eventType },
    cursor,
    limit,
    descending,
  ]);
}

// ─── Registry helpers ─────────────────────────────────────────────────────────

async function getRegistryInfo() {
  const obj = await getObject(CONFIG.identityId);
  const fields = obj.content.fields;
  return {
    counter:  parseInt(fields.counter, 10),
    tableId:  fields.agents.fields.id.id,
    objectId: CONFIG.identityId,
  };
}

async function getAllAgents() {
  const info = await getRegistryInfo();
  const agents = [];
  let cursor = null;

  while (true) {
    const page = await getDynamicFields(info.tableId, cursor, 50);
    for (const field of page.data ?? []) {
      const entryObjId = field.objectId;
      if (!entryObjId) continue;
      try {
        const obj = await getObject(entryObjId);
        const ef = obj.content.fields;
        agents.push({
          agentId:   parseInt(ef.agent_id, 10),
          globalId:  `sui:${CONFIG.network}:${CONFIG.identityId}:${ef.agent_id}`,
          owner:     ef.owner,
          agentUri:  ef.agent_uri,
          active:    ef.active,
          createdAt: parseInt(ef.created_at, 10),
          updatedAt: parseInt(ef.updated_at, 10),
        });
      } catch (e) {
        console.warn(`Could not fetch agent entry ${entryObjId}:`, e.message);
      }
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  return agents.sort((a, b) => a.agentId - b.agentId);
}

async function getReputationEvents(agentId) {
  const pkg = CONFIG.packageId;
  const feedbackType    = `${pkg}::reputation_registry::NewFeedback`;
  const revocationType  = `${pkg}::reputation_registry::FeedbackRevoked`;

  const allFeedback = [];

  // Fetch NewFeedback events
  let cursor = null;
  while (true) {
    const page = await queryEvents(feedbackType, cursor, 50, false);
    for (const ev of page.data ?? []) {
      const f = ev.parsedJson;
      if (parseInt(f.agent_id, 10) !== agentId) continue;
      allFeedback.push({
        index:     parseInt(f.feedback_index, 10),
        negative:  f.value_negative,
        magnitude: parseInt(f.value_magnitude, 10),
        tag1:      f.tag1 ?? "",
        tag2:      f.tag2 ?? "",
        revoked:   false,
        timestamp: parseInt(ev.timestampMs, 10),
      });
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  // Fetch revocations
  cursor = null;
  while (true) {
    const page = await queryEvents(revocationType, cursor, 50, false);
    for (const ev of page.data ?? []) {
      const f = ev.parsedJson;
      if (parseInt(f.agent_id, 10) !== agentId) continue;
      const idx = parseInt(f.feedback_index, 10);
      const item = allFeedback.find((x) => x.index === idx);
      if (item) item.revoked = true;
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  const active   = allFeedback.filter((f) => !f.revoked);
  const posSum   = active.filter((f) => !f.negative).reduce((s, f) => s + f.magnitude, 0);
  const negSum   = active.filter((f) =>  f.negative).reduce((s, f) => s + f.magnitude, 0);
  const netScore = posSum - negSum;

  return { feedback: allFeedback, count: active.length, positiveSum: posSum, negativeSum: negSum, netScore };
}

async function checkAgentReachable(uri, timeoutMs = 5000) {
  if (!uri?.startsWith("http")) return { reachable: false, reason: "Not HTTP" };
  try {
    const res = await fetch(uri, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { reachable: res.ok, reason: `HTTP ${res.status}` };
  } catch (e) {
    return { reachable: false, reason: e.message?.slice(0, 60) ?? "Error" };
  }
}

// ─── In-memory cache ──────────────────────────────────────────────────────────

const CACHE = {
  agents:       [],
  reputation:   {},      // agentId → rep summary
  health:       {},      // agentId → { reachable, reason, checkedAt }
  lastSync:     null,
  syncError:    null,
  history:      [],      // { ts, total, active } snapshots (last 60)
};

let syncInProgress = false;

async function syncData() {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    console.log("[sync] Fetching agents from SUI…");
    const agents = await getAllAgents();
    CACHE.agents = agents;
    CACHE.lastSync = Date.now();
    CACHE.syncError = null;

    // Record history snapshot
    const active = agents.filter((a) => a.active).length;
    CACHE.history.push({ ts: Date.now(), total: agents.length, active });
    if (CACHE.history.length > 60) CACHE.history.shift();

    // Fetch reputation for all agents in parallel (max 5 concurrent)
    const chunks = [];
    for (let i = 0; i < agents.length; i += 5)
      chunks.push(agents.slice(i, i + 5));

    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async (a) => {
          try {
            CACHE.reputation[a.agentId] = await getReputationEvents(a.agentId);
          } catch (e) {
            CACHE.reputation[a.agentId] = { netScore: 0, count: 0, positiveSum: 0, negativeSum: 0, feedback: [] };
          }
        })
      );
    }

    // Quick health checks (fire-and-forget per agent, don't block)
    agents.forEach(async (a) => {
      const result = await checkAgentReachable(a.agentUri, 4000);
      CACHE.health[a.agentId] = { ...result, checkedAt: Date.now() };
    });

    console.log(`[sync] Done — ${agents.length} agents loaded`);
    broadcastSync();
  } catch (e) {
    CACHE.syncError = e.message;
    console.error("[sync] Error:", e.message);
  } finally {
    syncInProgress = false;
  }
}

// Initial sync + periodic refresh every 30 s (chain data cadence)
syncData();
setInterval(syncData, 30_000);

// ─── Express app ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// ── API: summary stats ──────────────────────────────────────────────────────

app.get("/api/stats", (_req, res) => {
  const agents = CACHE.agents;
  const active = agents.filter((a) => a.active).length;
  const inactive = agents.length - active;

  const allFeedback = Object.values(CACHE.reputation).flatMap((r) => r.feedback ?? []);
  const totalFeedback = allFeedback.filter((f) => !f.revoked).length;
  const avgScore = agents.length === 0 ? 0
    : Object.values(CACHE.reputation).reduce((s, r) => s + (r.netScore ?? 0), 0) / agents.length;

  const reachable = Object.values(CACHE.health).filter((h) => h.reachable).length;

  res.json({
    totalAgents:   agents.length,
    activeAgents:  active,
    inactiveAgents: inactive,
    totalFeedback,
    avgScore:      parseFloat(avgScore.toFixed(2)),
    reachableAgents: reachable,
    lastSync:      CACHE.lastSync,
    syncError:     CACHE.syncError,
    network:       CONFIG.network,
    identityId:    CONFIG.identityId,
  });
});

// ── API: agent list ──────────────────────────────────────────────────────────

app.get("/api/agents", (req, res) => {
  const { page = 1, limit = 20, active, sort = "agentId", order = "asc" } = req.query;
  let agents = [...CACHE.agents];

  if (active !== undefined) {
    const flag = active === "true";
    agents = agents.filter((a) => a.active === flag);
  }

  // Attach reputation & health
  agents = agents.map((a) => ({
    ...a,
    reputation: CACHE.reputation[a.agentId] ?? null,
    health:     CACHE.health[a.agentId] ?? null,
  }));

  // Sort
  agents.sort((x, y) => {
    let xv = x[sort] ?? (sort === "netScore" ? x.reputation?.netScore ?? 0 : 0);
    let yv = y[sort] ?? (sort === "netScore" ? y.reputation?.netScore ?? 0 : 0);
    if (typeof xv === "string") xv = xv.toLowerCase();
    if (typeof yv === "string") yv = yv.toLowerCase();
    return order === "desc" ? (yv > xv ? 1 : -1) : (xv > yv ? 1 : -1);
  });

  const total  = agents.length;
  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const data   = agents.slice(offset, offset + parseInt(limit, 10));

  res.json({ data, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
});

// ── API: single agent ────────────────────────────────────────────────────────

app.get("/api/agents/:agentId", (req, res) => {
  const id = parseInt(req.params.agentId, 10);
  const agent = CACHE.agents.find((a) => a.agentId === id);
  if (!agent) return res.status(404).json({ error: "Agent not found" });
  res.json({
    ...agent,
    reputation: CACHE.reputation[id] ?? null,
    health:     CACHE.health[id] ?? null,
  });
});

// ── API: history sparkline ────────────────────────────────────────────────────

app.get("/api/history", (_req, res) => {
  res.json(CACHE.history);
});

// ── API: reputation leaderboard ───────────────────────────────────────────────

app.get("/api/leaderboard", (_req, res) => {
  const entries = CACHE.agents.map((a) => ({
    agentId:  a.agentId,
    agentUri: a.agentUri,
    active:   a.active,
    netScore: CACHE.reputation[a.agentId]?.netScore ?? 0,
    count:    CACHE.reputation[a.agentId]?.count ?? 0,
  }));
  entries.sort((a, b) => b.netScore - a.netScore);
  res.json(entries.slice(0, 10));
});

// ── API: force server-side re-sync ───────────────────────────────────────────

app.post("/api/sync", (_req, res) => {
  syncData(); // fire-and-forget; clients get notified via SSE when done
  res.json({ queued: true, ts: Date.now() });
});

// ── SSE: live feed ────────────────────────────────────────────────────────────

const sseClients = new Set();

app.get("/api/events", (req, res) => {
  res.set({
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial snapshot
  send("connected", { ts: Date.now() });

  sseClients.add(send);
  req.on("close", () => sseClients.delete(send));
});

// Broadcast after each sync
function broadcastSync() {
  const payload = { ts: Date.now(), total: CACHE.agents.length, lastSync: CACHE.lastSync };
  for (const send of sseClients) {
    try { send("sync", payload); } catch (_) { sseClients.delete(send); }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3333;
const server = createServer(app);
server.listen(PORT, () => {
  console.log(`\n  SUI A2A Registry Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
