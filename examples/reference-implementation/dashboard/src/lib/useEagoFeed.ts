import { useEffect, useRef, useState } from "react";
import type { FeedEvent } from "./types";

const MAX_EVENTS = 300;

/**
 * Connects to the orchestrator's global WebSocket feed (/ws/feed) and pushes
 * every phase transition the instant it happens - the real-time replacement
 * for genjinni's setInterval + sleep()-faked animation polling loop.
 */
export function useEagoFeed() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryDelay = 1000;

    function connect() {
      if (cancelled) return;
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws/feed`);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        retryDelay = 1000;
      };
      ws.onmessage = (msg) => {
        const event = JSON.parse(msg.data) as FeedEvent;
        setEvents((prev) => [event, ...prev].slice(0, MAX_EVENTS));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) {
          setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 1.5, 10000);
        }
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      cancelled = true;
      wsRef.current?.close();
    };
  }, []);

  return { events, connected };
}
