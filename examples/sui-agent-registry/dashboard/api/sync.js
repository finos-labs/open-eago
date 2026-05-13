// POST /api/sync — no-op on Vercel (no server-side cache to refresh).
// Responds immediately; client will poll on its own interval.
import { cors } from "./_sui.js";

export default function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });
  res.json({ queued: false, serverless: true, ts: Date.now() });
}
