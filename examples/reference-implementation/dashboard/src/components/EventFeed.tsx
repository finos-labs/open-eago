import { AnimatePresence, motion } from "framer-motion";
import { Card } from "./Card";
import { PHASE_LABELS, type FeedEvent, type Phase } from "../lib/types";

function describe(event: FeedEvent): string {
  if (event.event_type === "phase_completed") {
    const label = PHASE_LABELS[event.phase as Phase] ?? event.phase;
    const conformant = (event.data as { conformant?: boolean }).conformant;
    return `${label} completed - ${conformant ? "schema-conformant" : "NON-CONFORMANT"}`;
  }
  if (event.event_type.startsWith("status_")) {
    return `status -> ${event.event_type.replace("status_", "")}`;
  }
  if (event.event_type === "execution_started") {
    return "execution started";
  }
  return event.event_type;
}

export function EventFeed({ events }: { events: FeedEvent[] }) {
  return (
    <Card title="Live Audit Feed" subtitle="Every envelope, the instant it's processed">
      <div className="h-72 overflow-y-auto space-y-1.5 pr-1">
        <AnimatePresence initial={false}>
          {events.map((e, i) => (
            <motion.div
              key={`${e.execution_id}-${e.timestamp}-${i}`}
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
              className="text-xs font-mono flex items-baseline gap-2 border-b border-slate-800/60 pb-1"
            >
              <span className="text-slate-600 shrink-0">{e.timestamp.slice(11, 19)}</span>
              <span className="text-indigo-400 shrink-0">{e.execution_id.replace("exec-", "")}</span>
              <span className="text-slate-300 truncate">{describe(e)}</span>
            </motion.div>
          ))}
        </AnimatePresence>
        {events.length === 0 && (
          <div className="h-full flex items-center justify-center text-sm text-slate-600">
            Waiting for events...
          </div>
        )}
      </div>
    </Card>
  );
}
