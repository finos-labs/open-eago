// Serverless functions are stateless — no history to replay.
// We return a single snapshot of the current state so the chart
// has at least one data point on load.
import { getAllAgents, cors } from "./_sui.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const agents = await getAllAgents();
    const active = agents.filter((a) => a.active).length;
    res.json([{ ts: Date.now(), total: agents.length, active }]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
