"""
bridge_base.py — Shared bootstrap for all onboarding oracle bridges.
Port of bridge-base.js.

Provides:
  - arg()                  CLI flag / env-var reader
  - governance_preflight() Run all enabled governance pre-flight checks
  - call_mcp_tool()        Call an MCP server tool via JSON-RPC 2.0
  - bootstrap_bridge()     Parse common flags, build web3 + signer + governance contracts
"""

from __future__ import annotations

import asyncio
import glob
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Optional

import httpx
from web3 import AsyncWeb3, Web3
from web3.middleware import SignAndSendRawMiddlewareBuilder

from shared.abis import (
    ACTION_PERMIT_ABI,
    AUTONOMY_BOUNDS_ABI,
    FLOW_AUTH_ABI,
    IDENTITY_REGISTRY_ABI,
    REPUTATION_GATE_ABI,
)
from shared.prompt_verifier import PromptTamperError, verify_prompt_at_startup
from shared.vault_signer import BaseSigner, create_signer

logger = logging.getLogger(__name__)

# ── CLI / env helper ──────────────────────────────────────────────────────────

def arg(flag: str, env_var: str, default: Optional[str] = None) -> Optional[str]:
    """Read a CLI flag (--flag value) or fall back to an env var."""
    args = sys.argv[1:]
    try:
        idx = args.index(flag)
        if idx + 1 < len(args):
            return args[idx + 1]
    except ValueError:
        pass
    return os.getenv(env_var, default)


# ── Governance preflight ──────────────────────────────────────────────────────

async def governance_preflight(
    label: str,
    *,
    flow_id: str,
    agent_id: int,
    capability: bytes,
    tool_hash: bytes,
    contracts: dict,
) -> bool:
    """
    Run all enabled governance pre-flight checks before spending gas.
    Returns True if all pass; False (with a logger.warning) if any fail.

    contracts dict keys: flow_auth, reputation_gate, autonomy_bounds, action_permit
    """
    flow_auth       = contracts.get("flow_auth")
    reputation_gate = contracts.get("reputation_gate")
    autonomy_bounds = contracts.get("autonomy_bounds")
    action_permit   = contracts.get("action_permit")

    if flow_auth:
        ok = await flow_auth.functions.isAuthorized(flow_id, agent_id, capability).call()
        if not ok:
            logger.warning("[%s] [%s] flow-auth denied agentId=%s", label, flow_id, agent_id)
            return False

    if reputation_gate:
        ok = await reputation_gate.functions.meetsThreshold(agent_id, capability).call()
        if not ok:
            logger.warning("[%s] [%s] reputation gate failed agentId=%s", label, flow_id, agent_id)
            return False

    if autonomy_bounds:
        ok = await autonomy_bounds.functions.isToolEnabled(agent_id, tool_hash).call()
        if not ok:
            logger.warning("[%s] [%s] autonomy bounds revoked tool=%s", label, flow_id, tool_hash.hex())
            return False

    if action_permit:
        ok = await action_permit.functions.validateAction(flow_id, agent_id, tool_hash).call()
        if not ok:
            logger.warning("[%s] [%s] action permit denied tool=%s", label, flow_id, tool_hash.hex())
            return False

    return True


# ── Call MCP tool ─────────────────────────────────────────────────────────────

async def call_mcp_tool(
    endpoint: str,
    tool_name: str,
    args: dict[str, Any],
    trace_id: str = "",
) -> dict:
    """
    Call an MCP server tool via JSON-RPC 2.0 POST /mcp.
    Compatible with both the Node.js mcp-server-base.js and the Python FastMCP
    streamable-http transport (which also handles POST /mcp).

    Returns the parsed tool result dict.
    Raises on JSON-RPC error or empty response.
    """
    body = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": {**args, "trace_id": trace_id},
        },
    }

    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(
            f"{endpoint}/mcp",
            json=body,
            headers={"Content-Type": "application/json", "X-Trace-Id": trace_id},
        )
        response.raise_for_status()

    data = response.json()
    if "error" in data:
        raise RuntimeError(
            f"MCP error from {endpoint} tool={tool_name}: {json.dumps(data['error'])}"
        )

    raw = data.get("result", {}).get("content", [{}])[0].get("text")
    if not raw:
        raise RuntimeError(f"Empty MCP response from {endpoint} tool={tool_name}")

    return json.loads(raw)


# ── Web3 helper ───────────────────────────────────────────────────────────────

def build_web3(rpc_url: str, signer: BaseSigner) -> tuple[AsyncWeb3, Any]:
    """Build an AsyncWeb3 instance and inject the signer middleware."""
    w3 = AsyncWeb3(AsyncWeb3.AsyncHTTPProvider(rpc_url))

    # Inject signing middleware so contract.functions.foo().transact() works
    # without manually signing each tx.
    account = None
    if hasattr(signer, "_account"):
        account = signer._account
        w3.middleware_onion.add(
            SignAndSendRawMiddlewareBuilder.build(account)
        )
        w3.eth.default_account = account.address

    return w3, account


# ── Bootstrap ─────────────────────────────────────────────────────────────────

class BridgeContext:
    """Holds all resources initialised by bootstrap_bridge()."""

    def __init__(
        self,
        w3: AsyncWeb3,
        signer: BaseSigner,
        contracts: dict,
        agent_id: int,
        contract_address: str,
        card_raw: Optional[bytes],
    ) -> None:
        self.w3 = w3
        self.signer = signer
        self.contracts = contracts
        self.agent_id = agent_id
        self.contract_address = contract_address
        self.card_raw = card_raw

    @property
    def address(self) -> str:
        return self.signer.address


async def bootstrap_bridge(
    label: str,
    *,
    contract_flag: str,
    contract_env: str,
    agent_id_env: str,
    card_glob: Optional[str] = None,
    prompt_name: Optional[str] = None,
    prompt_version_env: str = "PROMPT_VERSION",
) -> BridgeContext:
    """
    Parse common CLI flags, build web3 provider / signer / governance contracts.
    Port of bootstrapBridge() in bridge-base.js.
    """
    rpc_url       = arg("--rpc",             "RPC_URL",             "http://127.0.0.1:8545")
    private_key   = arg("--privkey",         "ORACLE_PRIVATE_KEY")
    signer_type   = arg("--signer-type",     "SIGNER_TYPE",         "local")
    vault_url     = arg("--vault-url",       "VAULT_URL")
    vault_address = arg("--vault-address",   "ORACLE_ADDRESS")

    flow_auth_addr     = arg("--flow-auth",        "FLOW_AUTH_ADDRESS")
    reputation_addr    = arg("--reputation-gate",  "REPUTATION_GATE_ADDRESS")
    autonomy_addr      = arg("--autonomy-bounds",  "AUTONOMY_BOUNDS_ADDRESS")
    action_permit_addr = arg("--action-permit",    "ACTION_PERMIT_ADDRESS")
    identity_addr      = arg("--identity-registry","IDENTITY_REGISTRY_ADDRESS")
    prompt_registry_addr = arg("--prompt-registry","PROMPT_REGISTRY_ADDRESS")

    contract_address = arg(contract_flag, contract_env)
    raw_agent_id     = arg("--agent-id", agent_id_env, "0")
    agent_id         = int(raw_agent_id or "0")

    if not contract_address:
        logger.error("[%s] Missing %s / %s", label, contract_flag, contract_env)
        sys.exit(1)
    if signer_type == "local" and not private_key:
        logger.error("[%s] Missing --privkey / ORACLE_PRIVATE_KEY", label)
        sys.exit(1)

    signer = create_signer(
        signer_type=signer_type,
        private_key=private_key,
        vault_url=vault_url,
        vault_address=vault_address,
    )
    w3, _ = build_web3(rpc_url, signer)

    def _contract(addr: Optional[str], abi: list) -> Optional[Any]:
        if not addr:
            return None
        return w3.eth.contract(address=addr, abi=abi)

    contracts = {
        "flow_auth":       _contract(flow_auth_addr,     FLOW_AUTH_ABI),
        "reputation_gate": _contract(reputation_addr,    REPUTATION_GATE_ABI),
        "autonomy_bounds": _contract(autonomy_addr,      AUTONOMY_BOUNDS_ABI),
        "action_permit":   _contract(action_permit_addr, ACTION_PERMIT_ABI),
    }

    # Agent card hash startup check
    card_raw: Optional[bytes] = None
    if identity_addr and card_glob:
        agents_dir = Path(__file__).parent.parent.parent / "agents"
        matched = sorted(agents_dir.glob(card_glob))
        if matched:
            card_raw = matched[0].read_bytes()
            local_hash = "0x" + Web3.keccak(card_raw).hex()
            identity = w3.eth.contract(address=identity_addr, abi=IDENTITY_REGISTRY_ABI)
            on_chain_hash = await identity.functions.getCardHash(agent_id).call()
            on_chain_hex = "0x" + on_chain_hash.hex() if isinstance(on_chain_hash, bytes) else on_chain_hash
            zero = "0x" + "0" * 64
            if on_chain_hex != zero and on_chain_hex.lower() != local_hash.lower():
                logger.warning(
                    "[%s] WARNING card hash mismatch agentId=%s local=%s on-chain=%s",
                    label, agent_id, local_hash, on_chain_hex,
                )
            else:
                logger.info("[%s] Card hash OK agentId=%s: %s", label, agent_id, local_hash)

    # Prompt hash startup check (Layer 4)
    if prompt_registry_addr and prompt_name:
        prompt_ver = arg("--prompt-version", prompt_version_env)
        if prompt_ver:
            try:
                await verify_prompt_at_startup(
                    label,
                    w3,
                    registry_address=prompt_registry_addr,
                    prompt_name=prompt_name,
                    prompt_version=prompt_ver,
                )
            except PromptTamperError as exc:
                logger.error("%s", exc)
                sys.exit(1)
        else:
            logger.warning(
                "[%s] --prompt-version / %s not set — skipping prompt hash check",
                label, prompt_version_env,
            )

    logger.info("[%s] RPC        : %s", label, rpc_url)
    logger.info("[%s] Contract   : %s", label, contract_address)
    logger.info("[%s] Signer     : %s (%s)", label, signer_type, signer.address)
    logger.info("[%s] AgentId    : %s", label, agent_id)
    logger.info("[%s] FlowAuth   : %s", label, flow_auth_addr or "(disabled)")
    logger.info("[%s] RepGate    : %s", label, reputation_addr or "(disabled)")
    logger.info("[%s] AutoBounds : %s", label, autonomy_addr or "(disabled)")
    logger.info("[%s] ActionPerm : %s", label, action_permit_addr or "(disabled)")
    logger.info("[%s] PromptReg  : %s", label, prompt_registry_addr or "(disabled)")

    return BridgeContext(
        w3=w3,
        signer=signer,
        contracts=contracts,
        agent_id=agent_id,
        contract_address=contract_address,
        card_raw=card_raw,
    )
