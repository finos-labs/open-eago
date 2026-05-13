import { getAllAgents, getReputationEvents, cors } from "./_sui.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const agents = await getAllAgents();

    const repMap = {};
    const chunks = [];
    for (let i = 0; i < agents.length; i += 5) chunks.push(agents.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (a) => {
        try   { repMap[a.agentId] = await getReputationEvents(a.agentId); }
        catch { repMap[a.agentId] = { netScore: 0, count: 0 }; }
      }));
    }

    const entries = agents.map((a) => ({
      agentId:  a.agentId,
      agentUri: a.agentUri,
      active:   a.active,
      netScore: repMap[a.agentId]?.netScore ?? 0,
      count:    repMap[a.agentId]?.count ?? 0,
    }));

    entries.sort((a, b) => b.netScore - a.netScore);
    res.json(entries.slice(0, 10));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
