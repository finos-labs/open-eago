/**
 * Shared SUI RPC helpers for Vercel serverless functions.
 * Mirrors the logic in server.js but stateless (no cache).
 */

export const CONFIG = {
  rpcUrl:       "https://fullnode.testnet.sui.io:443",
  network:      "testnet",
  packageId:    "0xe7e6bfd3bfb1bb93accb07da8f3bfa95ed7aa70c231dc3d784a7052e1d336775",
  identityId:   "0xa7ab6d000862a7b30ed1b2e7d02baa131fa9530a9d4c67b39a1a1804b5b21193",
  reputationId: "0x8b3507234e8d98d235e395f0a42f6ea3e803d4524ff4e48539fb6fc6c79b3ac7",
  validationId: "0xf9527c669e6a0952053b0cfa91fe3429b2f39c8844f148b1e78132141f049048",
};

export async function rpc(method, params = []) {
  const res = await fetch(CONFIG.rpcUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal:  AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

export async function getObject(objectId) {
  const result = await rpc("sui_getObject", [objectId, { showContent: true }]);
  if (result?.error) throw new Error(`Object not found: ${objectId}`);
  return result?.data;
}

export async function getDynamicFields(parentId, cursor = null, limit = 50) {
  return rpc("suix_getDynamicFields", [parentId, cursor, limit]);
}

export async function getDynamicFieldObject(parentId, keyType, keyValue) {
  const result = await rpc("suix_getDynamicFieldObject", [
    parentId,
    { type: keyType, value: keyValue },
  ]);
  if (result?.error) throw new Error(`Dynamic field not found: ${keyValue}`);
  return result?.data;
}

export async function queryEvents(eventType, cursor = null, limit = 50, descending = true) {
  return rpc("suix_queryEvents", [
    { MoveEventType: eventType },
    cursor,
    limit,
    descending,
  ]);
}

export async function getRegistryInfo() {
  const obj    = await getObject(CONFIG.identityId);
  const fields = obj.content.fields;
  return {
    counter:  parseInt(fields.counter, 10),
    tableId:  fields.agents.fields.id.id,
    objectId: CONFIG.identityId,
  };
}

export async function getAllAgents() {
  const info   = await getRegistryInfo();
  const agents = [];
  let cursor   = null;

  while (true) {
    const page = await getDynamicFields(info.tableId, cursor, 50);
    for (const field of page.data ?? []) {
      const entryObjId = field.objectId;
      if (!entryObjId) continue;
      try {
        const obj = await getObject(entryObjId);
        const ef  = obj.content.fields;
        agents.push({
          agentId:   parseInt(ef.agent_id, 10),
          globalId:  `sui:${CONFIG.network}:${CONFIG.identityId}:${ef.agent_id}`,
          owner:     ef.owner,
          agentUri:  ef.agent_uri,
          active:    ef.active,
          createdAt: parseInt(ef.created_at, 10),
          updatedAt: parseInt(ef.updated_at, 10),
        });
      } catch (_) { /* skip unreadable entries */ }
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  return agents.sort((a, b) => a.agentId - b.agentId);
}

export async function getReputationEvents(agentId) {
  const pkg             = CONFIG.packageId;
  const feedbackType    = `${pkg}::reputation_registry::NewFeedback`;
  const revocationType  = `${pkg}::reputation_registry::FeedbackRevoked`;
  const allFeedback     = [];

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
      });
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  cursor = null;
  while (true) {
    const page = await queryEvents(revocationType, cursor, 50, false);
    for (const ev of page.data ?? []) {
      const f   = ev.parsedJson;
      if (parseInt(f.agent_id, 10) !== agentId) continue;
      const idx = parseInt(f.feedback_index, 10);
      const item = allFeedback.find((x) => x.index === idx);
      if (item) item.revoked = true;
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }

  const active  = allFeedback.filter((f) => !f.revoked);
  const posSum  = active.filter((f) => !f.negative).reduce((s, f) => s + f.magnitude, 0);
  const negSum  = active.filter((f) =>  f.negative).reduce((s, f) => s + f.magnitude, 0);

  return { feedback: allFeedback, count: active.length, positiveSum: posSum, negativeSum: negSum, netScore: posSum - negSum };
}

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
