"""
client_setup_bridge.py — Port of client-setup-bridge.js using web3.py AsyncWeb3.

Watches OnboardingRegistry.PhaseCompleted events and drives the three sequential
client setup phases.

  ALL_REVIEWS_DONE set   → setup_legal_entity → ClientSetupOracle.setupLegalEntity()
  ENTITY_SETUP_DONE set  → setup_account      → ClientSetupOracle.setupAccount()
  ACCOUNT_SETUP_DONE set → setup_products     → ClientSetupOracle.setupProducts()

Usage:
    python -m bridges.client_setup_bridge \
        --onboarding-registry 0x... \
        --setup-contract 0x... \
        --rpc http://... --privkey 0x... \
        --entity-agent-id 4 --account-agent-id 5 --product-agent-id 6
"""

from __future__ import annotations

import asyncio
import logging
import os

from web3 import Web3

from shared.abis import ONBOARDING_REGISTRY_ABI, SETUP_ORACLE_ABI
from shared.bridge_base import arg, call_mcp_tool
from shared.vault_signer import create_signer
from shared.bridge_base import build_web3

logger = logging.getLogger(__name__)

LABEL        = "setup-bridge"
MCP_ENDPOINT = arg("--mcp-endpoint", "SETUP_MCP_ENDPOINT", "http://localhost:8014")

RPC_URL        = arg("--rpc",             "RPC_URL",             "http://127.0.0.1:8545")
PRIVATE_KEY    = arg("--privkey",         "ORACLE_PRIVATE_KEY")
SIGNER_TYPE    = arg("--signer-type",     "SIGNER_TYPE",         "local")
VAULT_URL      = arg("--vault-url",       "VAULT_URL")
VAULT_ADDRESS  = arg("--vault-address",   "ORACLE_ADDRESS")

ONBOARDING_REG   = arg("--onboarding-registry",  "ONBOARDING_REGISTRY_ADDRESS")
SETUP_CONTRACT   = arg("--setup-contract",        "SETUP_CONTRACT_ADDRESS")
ENTITY_AGENT_ID  = int(arg("--entity-agent-id",  "ENTITY_AGENT_ID",  "4"))
ACCOUNT_AGENT_ID = int(arg("--account-agent-id", "ACCOUNT_AGENT_ID", "5"))
PRODUCT_AGENT_ID = int(arg("--product-agent-id", "PRODUCT_AGENT_ID", "6"))


def _hex(b) -> str:
    return b.hex() if isinstance(b, bytes) else str(b).removeprefix("0x")


def _bytes(h: str) -> bytes:
    return bytes.fromhex(h.removeprefix("0x"))


async def main() -> None:
    import sys
    if not ONBOARDING_REG:
        logger.error("[%s] Missing --onboarding-registry", LABEL); sys.exit(1)
    if not SETUP_CONTRACT:
        logger.error("[%s] Missing --setup-contract", LABEL); sys.exit(1)
    if SIGNER_TYPE == "local" and not PRIVATE_KEY:
        logger.error("[%s] Missing --privkey", LABEL); sys.exit(1)

    signer = create_signer(SIGNER_TYPE, PRIVATE_KEY, VAULT_URL, VAULT_ADDRESS)
    w3, _  = build_web3(RPC_URL, signer)

    registry    = w3.eth.contract(address=ONBOARDING_REG, abi=ONBOARDING_REGISTRY_ABI)
    setup_oracle= w3.eth.contract(address=SETUP_CONTRACT,  abi=SETUP_ORACLE_ABI)

    all_done     = await registry.functions.ALL_REVIEWS_DONE().call()
    entity_done  = await registry.functions.PHASE_ENTITY_SETUP_DONE().call()
    account_done = await registry.functions.PHASE_ACCOUNT_SETUP_DONE().call()
    product_done = 0x20

    logger.info("[%s] OnboardingRegistry : %s", LABEL, ONBOARDING_REG)
    logger.info("[%s] ClientSetupOracle  : %s", LABEL, SETUP_CONTRACT)
    logger.info("[%s] MCP endpoint       : %s", LABEL, MCP_ENDPOINT)
    logger.info("[%s] EntityAgentId      : %d", LABEL, ENTITY_AGENT_ID)
    logger.info("[%s] AccountAgentId     : %d", LABEL, ACCOUNT_AGENT_ID)
    logger.info("[%s] ProductAgentId     : %d", LABEL, PRODUCT_AGENT_ID)
    logger.info("[%s] Listening for PhaseCompleted events…", LABEL)

    phase_filter = await registry.events.PhaseCompleted.create_filter(from_block="latest")

    while True:
        for event in await phase_filter.get_new_entries():
            asyncio.create_task(_handle_phase_completed(
                registry, setup_oracle, event, all_done, entity_done, account_done, product_done,
            ))
        await asyncio.sleep(2)


async def _handle_phase_completed(registry, setup_oracle, event, all_done, entity_done, account_done, product_done) -> None:
    args    = event["args"]
    flow_id = args["flowId"]
    phase   = args["phase"]
    mask    = await registry.functions.phaseBitmask(flow_id).call()

    flow_hex = _hex(flow_id)
    logger.info(
        "\n[%s] ← PhaseCompleted  flowId=%s  phase=0x%02x  mask=0x%02x",
        LABEL, flow_hex, phase, mask,
    )

    # ALL_REVIEWS_DONE → legal entity setup
    if (mask & all_done) == all_done and (mask & entity_done) == 0:
        try:
            logger.info("[%s]   → setup_legal_entity", LABEL)
            result = await call_mcp_tool(MCP_ENDPOINT, "setup_legal_entity", {"flow_id": flow_hex}, flow_hex)
            tx = await setup_oracle.functions.setupLegalEntity(
                flow_id, ENTITY_AGENT_ID, _bytes(result["entity_spec_hash"])
            ).transact()
            logger.info("[%s]   ✓ setupLegalEntity  tx=%s", LABEL, tx.hex())
        except Exception as exc:
            logger.error("[%s]   ✗ %s", LABEL, exc)
        return

    # ENTITY_SETUP_DONE → account setup
    if (mask & entity_done) == entity_done and (mask & account_done) == 0:
        try:
            logger.info("[%s]   → setup_account", LABEL)
            result = await call_mcp_tool(MCP_ENDPOINT, "setup_account", {"flow_id": flow_hex}, flow_hex)
            tx = await setup_oracle.functions.setupAccount(
                flow_id, ACCOUNT_AGENT_ID, _bytes(result["account_spec_hash"])
            ).transact()
            logger.info("[%s]   ✓ setupAccount  tx=%s", LABEL, tx.hex())
        except Exception as exc:
            logger.error("[%s]   ✗ %s", LABEL, exc)
        return

    # ACCOUNT_SETUP_DONE → product setup
    if (mask & account_done) == account_done and (mask & product_done) == 0:
        try:
            logger.info("[%s]   → setup_products", LABEL)
            result = await call_mcp_tool(MCP_ENDPOINT, "setup_products", {"flow_id": flow_hex}, flow_hex)
            tx = await setup_oracle.functions.setupProducts(
                flow_id, PRODUCT_AGENT_ID, _bytes(result["product_spec_hash"])
            ).transact()
            logger.info("[%s]   ✓ setupProducts  tx=%s", LABEL, tx.hex())
        except Exception as exc:
            logger.error("[%s]   ✗ %s", LABEL, exc)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())
