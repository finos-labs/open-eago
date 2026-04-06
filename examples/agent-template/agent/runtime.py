"""Runtime state and metrics for the OpenEAGO agent."""
from __future__ import annotations

from datetime import datetime


class AgentRuntime:
    """Runtime state mirroring openemcp-clm/common/base_agent.py metrics."""

    def __init__(self, agent_name: str):
        self.agent_name = agent_name
        self.running = False
        self.start_time: datetime | None = None
        self.request_count = 0
        self.error_count = 0
        # Populated when a risk config section is present and risk context is active.
        self.risk_context: dict | None = None

    def start(self) -> None:
        self.running = True
        self.start_time = datetime.now()

    def stop(self) -> None:
        self.running = False

    def uptime_seconds(self) -> float:
        if not self.start_time:
            return 0.0
        return (datetime.now() - self.start_time).total_seconds()

    def uptime_percentage(self) -> float:
        if not self.start_time:
            return 0.0
        running_time = self.uptime_seconds()
        return min(99.9, (running_time / (running_time + 1)) * 100)

    def reliability(self) -> float:
        if self.request_count == 0:
            return 1.0
        success_rate = (self.request_count - self.error_count) / self.request_count
        return max(0.0, min(1.0, success_rate))

    def health_payload(self) -> dict:
        return {
            "agent": self.agent_name,
            "status": "healthy" if self.running else "unhealthy",
            "uptime_percentage": self.uptime_percentage(),
            "reliability": self.reliability(),
            "running": self.running,
            "start_time": self.start_time.isoformat() if self.start_time else None,
            "risk_context": self.risk_context,
        }

    def metrics_payload(self) -> dict:
        return {
            "agent": self.agent_name,
            "request_count": self.request_count,
            "error_count": self.error_count,
            "success_count": self.request_count - self.error_count,
            "reliability": self.reliability(),
            "uptime_seconds": self.uptime_seconds(),
            "uptime_percentage": self.uptime_percentage(),
            "risk_context": self.risk_context,
        }
