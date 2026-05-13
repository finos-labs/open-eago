import { getAllAgents, getReputationEvents, CONFIG, cors } from "./_sui.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const agents = await getAllAgents();

    // Fetch reputation in parallel (batches of 5)
    const repMap = {};
    const chunks = [];
    for (let i = 0; i < agents.length; i += 5) chunks.push(agents.slice(i, i + 5));
    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (a) => {
        try   { repMap[a.agentId] = await getReputationEvents(a.agentId); }
        catch { repMap[a.agentId] = { netScore: 0, count: 0, positiveSum: 0, negativeSum: 0, feedback: [] }; }
      }));
    }

    const active        = agents.filter((a) => a.active).length;
    const totalFeedback = Object.values(repMap).reduce((s, r) => s + r.count, 0);
    const avgScore      = agents.length === 0 ? 0
      : Object.values(repMap).reduce((s, r) => s + r.netScore, 0) / agents.length;

    res.json({
      totalAgents:     agents.length,
      activeAgents:    active,
      inactiveAgents:  agents.length - active,
      totalFeedback,
      avgScore:        parseFloat(avgScore.toFixed(2)),
      reachableAgents: 0,   // health checks not run on serverless to save time
      lastSync:        Date.now(),
      syncError:       null,
      network:         CONFIG.network,
      identityId:      CONFIG.identityId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
