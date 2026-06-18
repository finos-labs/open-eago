"""OpenEAGO reference implementation orchestrator.

FastAPI app that drives the six-phase pipeline (app/workflow.py) across the
real agent-template processes discovered via the agent-registry, persists
every step to MongoDB, and pushes live updates over WebSocket - the
real-time replacement for openemcp-genjinni's REST-polling dashboard hook.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import persistence, registry_client, workflow
from app.seed_scenarios import SCENARIOS
from app.ws_hub import hub

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("orchestrator.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await persistence.connect()
    logger.info("Connected to MongoDB")
    yield
    await persistence.disconnect()


app = FastAPI(
    title="OpenEAGO Reference Implementation Orchestrator",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"],
)


class SubmitExecutionRequest(BaseModel):
    task_data: dict[str, Any] | None = None
    scenario: str | None = None


class HitlDecisionRequest(BaseModel):
    decision: str  # approved | rejected | modified
    reviewer_id: str | None = None


@app.get("/", tags=["system"])
async def root():
    return {"name": "OpenEAGO Reference Implementation Orchestrator", "status": "running", "docs_url": "/docs"}


@app.get("/health", tags=["system"])
async def health():
    mongo_ok = True
    try:
        await persistence.db().command("ping")
    except Exception:
        mongo_ok = False
    agents = await registry_client.list_agents()
    return {
        "status": "healthy" if mongo_ok else "degraded",
        "mongodb": "connected" if mongo_ok else "disconnected",
        "registered_agents": len(agents),
    }


@app.get("/api/v1/scenarios", tags=["executions"])
async def list_scenarios():
    return {"scenarios": [{"name": name, "task_data": data} for name, data in SCENARIOS.items()]}


@app.post("/api/v1/executions", status_code=202, tags=["executions"])
async def submit_execution(request: SubmitExecutionRequest):
    if request.scenario:
        if request.scenario not in SCENARIOS:
            raise HTTPException(400, f"unknown scenario '{request.scenario}'. Known: {list(SCENARIOS)}")
        task_data = SCENARIOS[request.scenario]
    elif request.task_data:
        task_data = request.task_data
    else:
        raise HTTPException(400, "provide either 'scenario' or 'task_data'")

    execution_id, session_id = await workflow.start_execution(task_data, request.scenario)
    asyncio.create_task(workflow.run_graph_background(execution_id, session_id, task_data))
    return {"execution_id": execution_id, "session_id": session_id, "status": "running"}


@app.get("/api/v1/executions", tags=["executions"])
async def list_executions(status: str | None = None, limit: int = 100):
    executions = await persistence.list_executions(limit=limit, status=status)
    return {"total": len(executions), "executions": executions}


@app.get("/api/v1/executions/pending-hitl", tags=["executions"])
async def pending_hitl():
    executions = await persistence.list_pending_hitl()
    return {"total": len(executions), "executions": executions}


@app.get("/api/v1/executions/{execution_id}", tags=["executions"])
async def get_execution(execution_id: str):
    doc = await persistence.get_execution(execution_id)
    if doc is None:
        raise HTTPException(404, f"execution {execution_id} not found")
    return doc


@app.post("/api/v1/executions/{execution_id}/hitl-decision", tags=["executions"])
async def hitl_decision(execution_id: str, request: HitlDecisionRequest):
    if request.decision not in ("approved", "rejected", "modified"):
        raise HTTPException(400, "decision must be one of: approved, rejected, modified")
    try:
        state = await workflow.finalize_hitl_decision(execution_id, request.decision, request.reviewer_id)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e

    asyncio.create_task(workflow.continue_after_hitl_background(execution_id, request.decision, state))
    return {"execution_id": execution_id, "status": "running", "hitl_decision": request.decision}


@app.get("/api/v1/agents", tags=["registry"])
async def list_agents():
    agents = await registry_client.list_agents()
    return {"total": len(agents), "agents": agents}


@app.get("/api/v1/events", tags=["events"])
async def list_events(limit: int = 100):
    events = await persistence.list_recent_events(limit=limit)
    return {"total": len(events), "events": events}


@app.get("/api/v1/kpis", tags=["events"])
async def kpis():
    return await persistence.kpi_summary()


@app.websocket("/ws/feed")
async def ws_feed(websocket: WebSocket):
    await hub.connect_global(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect_global(websocket)


@app.websocket("/ws/executions/{execution_id}")
async def ws_execution(websocket: WebSocket, execution_id: str):
    await hub.connect_execution(websocket, execution_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        hub.disconnect_execution(websocket, execution_id)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=False)
