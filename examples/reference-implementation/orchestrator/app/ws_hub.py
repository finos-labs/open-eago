"""WebSocket broadcast hub - the real-time upgrade over genjinni's REST-polling
+ sleep()-faked animation (ui/dashboard/src/hooks/useWorkflowExecution.js).
Every phase transition is pushed the instant it happens to:
  - /ws/feed                  - every execution's events (global live feed)
  - /ws/executions/{exec_id}  - only that execution's events (detail view)
"""
from __future__ import annotations

from fastapi import WebSocket


class Hub:
    def __init__(self) -> None:
        self._global: set[WebSocket] = set()
        self._by_execution: dict[str, set[WebSocket]] = {}

    async def connect_global(self, ws: WebSocket) -> None:
        await ws.accept()
        self._global.add(ws)

    async def connect_execution(self, ws: WebSocket, execution_id: str) -> None:
        await ws.accept()
        self._by_execution.setdefault(execution_id, set()).add(ws)

    def disconnect_global(self, ws: WebSocket) -> None:
        self._global.discard(ws)

    def disconnect_execution(self, ws: WebSocket, execution_id: str) -> None:
        peers = self._by_execution.get(execution_id)
        if peers:
            peers.discard(ws)
            if not peers:
                self._by_execution.pop(execution_id, None)

    async def broadcast(self, event: dict) -> None:
        execution_id = event.get("execution_id")
        dead: list[WebSocket] = []
        for ws in self._global:
            try:
                await ws.send_json(event)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._global.discard(ws)

        if execution_id and execution_id in self._by_execution:
            dead = []
            for ws in self._by_execution[execution_id]:
                try:
                    await ws.send_json(event)
                except Exception:
                    dead.append(ws)
            for ws in dead:
                self.disconnect_execution(ws, execution_id)


hub = Hub()
