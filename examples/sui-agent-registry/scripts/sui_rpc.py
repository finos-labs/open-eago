"""
sui_rpc.py — Minimal SUI JSON-RPC helpers (stdlib only, no dependencies).

All functions raise RuntimeError on RPC errors.
"""

import json
import urllib.request
from datetime import datetime, timezone
from typing import Any

RPC_URL = "https://fullnode.testnet.sui.io:443"

PACKAGE_ID    = "0xe7e6bfd3bfb1bb93accb07da8f3bfa95ed7aa70c231dc3d784a7052e1d336775"
IDENTITY_ID   = "0xa7ab6d000862a7b30ed1b2e7d02baa131fa9530a9d4c67b39a1a1804b5b21193"
REPUTATION_ID = "0x8b3507234e8d98d235e395f0a42f6ea3e803d4524ff4e48539fb6fc6c79b3ac7"
VALIDATION_ID = "0xf9527c669e6a0952053b0cfa91fe3429b2f39c8844f148b1e78132141f049048"
NETWORK     = "testnet"
CLOCK_ID    = "0x6"


# ─── Raw RPC call ─────────────────────────────────────────────────────────────

def rpc(method: str, params: list[Any] = [], *, url: str = RPC_URL) -> Any:
    """Send a JSON-RPC 2.0 request and return the result field."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode()
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
    if "error" in data:
        raise RuntimeError(f"RPC error: {data['error']}")
    return data["result"]


# ─── Object helpers ───────────────────────────────────────────────────────────

def get_object(object_id: str) -> dict:
    """Fetch a SUI object with content."""
    result = rpc("sui_getObject", [object_id, {"showContent": True}])
    if result.get("error"):
        raise RuntimeError(f"Object not found: {object_id}")
    return result["data"]


def get_dynamic_field_object(parent_id: str, key_type: str, key_value: str) -> dict:
    """Fetch a dynamic field object by parent + key."""
    result = rpc("suix_getDynamicFieldObject", [
        parent_id,
        {"type": key_type, "value": key_value},
    ])
    if result.get("error"):
        raise RuntimeError(f"Dynamic field not found: {key_value} in {parent_id}")
    return result["data"]


def get_dynamic_fields(parent_id: str, cursor: str | None = None, limit: int = 50) -> dict:
    """List dynamic field descriptors under a parent object."""
    params = [parent_id, cursor, limit]
    return rpc("suix_getDynamicFields", params)


# ─── Registry-specific helpers ────────────────────────────────────────────────

def get_registry_info() -> dict:
    """Return registry fields including counter and ObjectTable inner ID."""
    obj = get_object(IDENTITY_ID)
    fields = obj["content"]["fields"]
    table_id = fields["agents"]["fields"]["id"]["id"]
    counter  = int(fields["counter"])
    return {"counter": counter, "table_id": table_id, "object_id": IDENTITY_ID}


def get_agent_entry(agent_id: int) -> dict:
    """Fetch an AgentEntry by numeric agent ID. Returns parsed field dict."""
    info = get_registry_info()
    entry = get_dynamic_field_object(info["table_id"], "u64", str(agent_id))
    ef = entry["content"]["fields"]
    return {
        "agent_id":   int(ef["agent_id"]),
        "global_id":  f"sui:{NETWORK}:{IDENTITY_ID}:{agent_id}",
        "owner":      ef["owner"],
        "agent_uri":  ef["agent_uri"],
        "active":     ef["active"],
        "created_at": datetime.fromtimestamp(int(ef["created_at"]) / 1000, tz=timezone.utc).isoformat(),
        "updated_at": datetime.fromtimestamp(int(ef["updated_at"]) / 1000, tz=timezone.utc).isoformat(),
    }


def fetch_agent_card(uri: str) -> dict | None:
    """HTTP-fetch and parse the agent.json card from the stored URI."""
    if not uri.startswith("http"):
        return None
    try:
        req = urllib.request.Request(uri, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.load(resp)
    except Exception as exc:
        print(f"  Warning: could not fetch agent card: {exc}")
        return None


def check_agent_reachable(uri: str, timeout: int = 5) -> tuple[bool, str]:
    """Try to HTTP-fetch the agent URI. Returns (reachable, reason)."""
    if not uri.startswith("http"):
        return False, "URI is not HTTP"
    try:
        req = urllib.request.Request(uri, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 200:
                return True, "OK"
            return False, f"HTTP {resp.status}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}"
    except urllib.error.URLError as e:
        return False, str(e.reason)
    except Exception as e:
        return False, str(e)


# ─── Event querying ───────────────────────────────────────────────────────────

def query_events(event_type: str, cursor: dict | None = None, limit: int = 50) -> dict:
    """
    Query SUI events by MoveEventType.
    event_type example: "0xPKG::reputation_registry::NewFeedback"
    Returns the raw page dict with 'data', 'hasNextPage', 'nextCursor'.
    """
    return rpc("suix_queryEvents", [
        {"MoveEventType": event_type},
        cursor,
        limit,
        False,  # descending=False → oldest first
    ])


def get_all_events(event_type: str) -> list[dict]:
    """Fetch all events of a given type (auto-paginate)."""
    events = []
    cursor = None
    while True:
        page = query_events(event_type, cursor=cursor, limit=50)
        events.extend(page.get("data", []))
        if not page.get("hasNextPage"):
            break
        cursor = page.get("nextCursor")
    return events


# ─── Reputation helpers ───────────────────────────────────────────────────────

def get_reputation_events(agent_id: int) -> dict:
    """
    Return all NewFeedback and FeedbackRevoked events for a given agent_id.
    Applies revocations so the returned feedback list only contains live records.

    Returns:
        {
            "feedback": [
                {
                    "client":     str,
                    "index":      int,
                    "negative":   bool,
                    "magnitude":  int,
                    "decimals":   int,
                    "tag1":       str,
                    "tag2":       str,
                    "endpoint":   str,
                    "revoked":    bool,
                    "timestamp":  str,
                }
            ],
            "count":        int,   # non-revoked
            "positive_sum": int,
            "negative_sum": int,
            "net_score":    int,   # positive_sum - negative_sum (raw magnitude)
        }
    """
    new_type    = f"{PACKAGE_ID}::reputation_registry::NewFeedback"
    revoke_type = f"{PACKAGE_ID}::reputation_registry::FeedbackRevoked"

    new_events    = get_all_events(new_type)
    revoke_events = get_all_events(revoke_type)

    # Build revocation set: (client, index)
    revoked = set()
    for ev in revoke_events:
        p = ev.get("parsedJson", {})
        if int(p.get("agent_id", -1)) == agent_id:
            revoked.add((p["client_address"], int(p["feedback_index"])))

    feedback = []
    for ev in new_events:
        p = ev.get("parsedJson", {})
        if int(p.get("agent_id", -1)) != agent_id:
            continue
        client = p["client_address"]
        index  = int(p["feedback_index"])
        is_rev = (client, index) in revoked
        ts_ms  = int(ev.get("timestampMs", 0))
        ts     = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).isoformat() if ts_ms else ""
        feedback.append({
            "client":    client,
            "index":     index,
            "negative":  p.get("value_negative", False),
            "magnitude": int(p.get("value_magnitude", 0)),
            "decimals":  int(p.get("value_decimals", 0)),
            "tag1":      p.get("tag1", ""),
            "tag2":      p.get("tag2", ""),
            "endpoint":  p.get("endpoint", ""),
            "revoked":   is_rev,
            "timestamp": ts,
        })

    pos_sum = sum(f["magnitude"] for f in feedback if not f["negative"] and not f["revoked"])
    neg_sum = sum(f["magnitude"] for f in feedback if f["negative"] and not f["revoked"])
    count   = sum(1 for f in feedback if not f["revoked"])

    return {
        "feedback":     feedback,
        "count":        count,
        "positive_sum": pos_sum,
        "negative_sum": neg_sum,
        "net_score":    pos_sum - neg_sum,
    }
