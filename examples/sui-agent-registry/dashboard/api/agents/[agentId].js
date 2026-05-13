import { getReputationEvents, getDynamicFieldObject, getRegistryInfo, CONFIG, cors } from "../_sui.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const agentId = parseInt(req.query.agentId, 10);
    if (isNaN(agentId)) return res.status(400).json({ error: "Invalid agentId" });

    // Fetch the specific agent entry
    const info  = await getRegistryInfo();
    const entry = await getDynamicFieldObject(info.tableId, "u64", String(agentId));
    const ef    = entry.content.fields;

    const agent = {
      agentId:   parseInt(ef.agent_id, 10),
      globalId:  `sui:${CONFIG.network}:${CONFIG.identityId}:${ef.agent_id}`,
      owner:     ef.owner,
      agentUri:  ef.agent_uri,
      active:    ef.active,
      createdAt: parseInt(ef.created_at, 10),
      updatedAt: parseInt(ef.updated_at, 10),
    };

    let reputation = null;
    try { reputation = await getReputationEvents(agentId); } catch (_) {}

    res.json({ ...agent, reputation, health: null });
  } catch (e) {
    const status = e.message.includes("not found") ? 404 : 500;
    res.status(status).json({ error: e.message });
  }
}
