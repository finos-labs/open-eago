// SSE is not supported in Vercel serverless functions (no persistent connections).
// This stub returns a well-formed SSE response that immediately ends so the
// client gracefully falls back to its interval-polling engine.
import { cors } from "./_sui.js";

export default function handler(req, res) {
  cors(res);
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  // Tell the client we're alive, then close cleanly.
  res.write("event: connected\ndata: {\"serverless\":true}\n\n");
  res.end();
}
