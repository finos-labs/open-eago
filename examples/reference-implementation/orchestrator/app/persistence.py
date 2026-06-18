"""MongoDB persistence for execution state and the audit/event trail.

Mirrors openemcp-genjinni's "save state after every agent step" pattern
(app/database/workflow_persistence.py) but async (Motor) and keyed by the
six canonical OpenEAGO phases instead of ad-hoc agent names.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient

from app.config import MONGODB_DATABASE, MONGODB_URI

_client: AsyncIOMotorClient | None = None


def db():
    assert _client is not None, "MongoDB not connected - call persistence.connect() first"
    return _client[MONGODB_DATABASE]


async def connect() -> None:
    global _client
    _client = AsyncIOMotorClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    await _client.admin.command("ping")


async def disconnect() -> None:
    global _client
    if _client is not None:
        _client.close()
        _client = None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def create_execution(execution_id: str, session_id: str, task_data: dict, scenario: str | None) -> None:
    doc = {
        "_id": execution_id,
        "execution_id": execution_id,
        "session_id": session_id,
        "scenario": scenario,
        "status": "running",
        "task_data": task_data,
        "phases": {},
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db().executions.insert_one(doc)
    await record_event(execution_id, "lifecycle", "execution_started", {"scenario": scenario})


async def save_phase(execution_id: str, phase: str, doc: dict, conformant: bool, errors: list[str]) -> dict:
    await db().executions.update_one(
        {"_id": execution_id},
        {
            "$set": {
                f"phases.{phase}": {
                    "document": doc,
                    "conformant": conformant,
                    "errors": errors,
                    "recorded_at": _now(),
                },
                "updated_at": _now(),
            }
        },
    )
    return await record_event(
        execution_id, phase, "phase_completed", {"conformant": conformant, "document": doc}
    )


async def set_status(execution_id: str, status: str, extra: dict[str, Any] | None = None) -> dict:
    update = {"status": status, "updated_at": _now()}
    if extra:
        update.update(extra)
    await db().executions.update_one({"_id": execution_id}, {"$set": update})
    return await record_event(execution_id, "lifecycle", f"status_{status}", extra or {})


async def save_validation_draft(execution_id: str, draft: dict) -> None:
    await db().executions.update_one(
        {"_id": execution_id},
        {"$set": {"validation_draft": draft, "updated_at": _now()}},
    )


async def record_event(execution_id: str, phase: str, event_type: str, data: dict) -> dict:
    event = {
        "execution_id": execution_id,
        "phase": phase,
        "event_type": event_type,
        "timestamp": _now(),
        "data": data,
    }
    result = await db().events.insert_one(dict(event))
    event["_id"] = str(result.inserted_id)
    return event


async def get_execution(execution_id: str) -> dict | None:
    return await db().executions.find_one({"_id": execution_id})


async def list_executions(limit: int = 100, status: str | None = None) -> list[dict]:
    query = {"status": status} if status else {}
    cursor = db().executions.find(query).sort("created_at", -1).limit(limit)
    return [doc async for doc in cursor]


async def list_pending_hitl() -> list[dict]:
    cursor = db().executions.find({"status": "awaiting_hitl"}).sort("created_at", -1)
    return [doc async for doc in cursor]


async def list_recent_events(limit: int = 100) -> list[dict]:
    cursor = db().events.find({}).sort("timestamp", -1).limit(limit)
    events = [doc async for doc in cursor]
    for e in events:
        e["_id"] = str(e["_id"])
    return events


async def kpi_summary() -> dict:
    total = await db().executions.count_documents({})
    completed = await db().executions.count_documents({"status": "completed"})
    rejected = await db().executions.count_documents({"status": "rejected"})
    awaiting_hitl = await db().executions.count_documents({"status": "awaiting_hitl"})
    return {
        "total_executions": total,
        "completed": completed,
        "rejected": rejected,
        "awaiting_hitl": awaiting_hitl,
        "approval_rate": round(completed / total, 3) if total else None,
    }
