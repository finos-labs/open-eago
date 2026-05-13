import { getAllAgents, getReputationEvents, cors } from "./_sui.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const { page = 1, limit = 20, active, sort = "agentId", order = "asc" } = req.query;

    let agents = await getAllAgents();

    if (active !== undefined) {
      const flag = active === "true";
      agents = agents.filter((a) => a.active === flag);
    }

    // Attach reputation (batched)
    const repMap = {};
    const chunks = [];
    for (let i = 0; i < agents.length; i += 5) chunks.push(agents.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (a) => {
        try   { repMap[a.agentId] = await getReputationEvents(a.agentId); }
        catch { repMap[a.agentId] = { netScore: 0, count: 0, positiveSum: 0, negativeSum: 0, feedback: [] }; }
      }));
    }

    agents = agents.map((a) => ({
      ...a,
      reputation: repMap[a.agentId] ?? null,
      health:     null,
    }));

    // Sort
    agents.sort((x, y) => {
      let xv = sort === "netScore" ? (x.reputation?.netScore ?? 0) : (x[sort] ?? 0);
      let yv = sort === "netScore" ? (y.reputation?.netScore ?? 0) : (y[sort] ?? 0);
      if (typeof xv === "string") xv = xv.toLowerCase();
      if (typeof yv === "string") yv = yv.toLowerCase();
      return order === "desc" ? (yv > xv ? 1 : -1) : (xv > yv ? 1 : -1);
    });

    const total  = agents.length;
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const data   = agents.slice(offset, offset + parseInt(limit, 10));

    res.json({ data, total, page: parseInt(page, 10), limit: parseInt(limit, 10) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
