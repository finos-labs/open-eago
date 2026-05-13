/**
 * Identity Registry helpers — read and write wrappers for identity_registry.move
 * Extended with OpenEAGO (FINOS Labs) governance transaction builders.
 */
import { SuiClient, SuiObjectResponse } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type {
  AgentEntry,
  SlaMetrics,
  SuiAgentRegistryConfig,
} from "./types.js";
import { AgentType, LifecycleState, RiskTier, SkillProficiency } from "./types.js";

/** Build the global agent ID string: `sui:{network}:{registryObjectId}:{agentId}` */
export function buildGlobalId(
  network: string,
  registryObjectId: string,
  agentId: number
): string {
  return `sui:${network}:${registryObjectId}:${agentId}`;
}

/**
 * Read an AgentEntry from the on-chain ObjectTable.
 *
 * The AgentEntry is stored as a child object inside the ObjectTable.
 * We query the registry shared object and parse its fields.
 */
export async function getAgent(
  client: SuiClient,
  config: SuiAgentRegistryConfig,
  agentId: number
): Promise<AgentEntry | null> {
  // The agents field is an ObjectTable whose entries live under the table's
  // inner UID, not directly under the registry object ID.
  try {
    const registry = await client.getObject({
      id: config.registryObjectIds.identity,
      options: { showContent: true },
    });
    const regFields = extractFields(registry);
    const tableId: string | undefined =
      (regFields?.["agents"] as { fields?: { id?: { id?: string } } })
        ?.fields?.id?.id;
    if (!tableId) return null;

    const resp = await client.getDynamicFieldObject({
      parentId: tableId,
      name: { type: "u64", value: agentId.toString() },
    });
    return parseAgentEntry(resp, config, agentId);
  } catch {
    return null;
  }
}

/**
 * Return the total number of registered agents (= counter field).
 */
export async function getAgentCount(
  client: SuiClient,
  config: SuiAgentRegistryConfig
): Promise<number> {
  const obj = await client.getObject({
    id: config.registryObjectIds.identity,
    options: { showContent: true },
  });
  const fields = extractFields(obj);
  if (!fields) return 0;
  return Number(fields["counter"] ?? 0);
}

/**
 * Build a PTB transaction to register a new agent.
 * Caller must sign and execute the returned Transaction.
 */
export function buildRegisterTx(
  config: SuiAgentRegistryConfig,
  agentUri: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::register`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.pure.string(agentUri),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to register without a URI (URI added later).
 */
export function buildRegisterEmptyTx(
  config: SuiAgentRegistryConfig,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::register_empty`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to update the agent URI.
 */
export function buildSetAgentUriTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  newUri: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_agent_uri`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(newUri),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to set the agent wallet address.
 */
export function buildSetAgentWalletTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  newWallet: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_agent_wallet`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.address(newWallet),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to unset the agent wallet.
 */
export function buildUnsetAgentWalletTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::unset_agent_wallet`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to set arbitrary metadata on an agent.
 */
export function buildSetMetadataTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  key: string,
  value: Uint8Array,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_metadata`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(key),
      tx.pure.vector("u8", Array.from(value)),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

// ─── OpenEAGO governance transaction builders ────────────────────────────────

/**
 * Register a new agent with full OpenEAGO governance metadata.
 *
 * Calls `identity_registry::register_with_governance` on-chain.
 * `agentType` must be one of the four OpenEAGO classifications (0–3).
 * `jurisdiction` e.g. "US-EAST", "EU", "APAC" (empty string = unset).
 */
export function buildRegisterWithGovernanceTx(
  config: SuiAgentRegistryConfig,
  agentUri: string,
  agentType: AgentType,
  jurisdiction: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::register_with_governance`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.pure.string(agentUri),
      tx.pure.u8(agentType),
      tx.pure.string(jurisdiction),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Register without a URI but with full OpenEAGO governance metadata.
 */
export function buildRegisterEmptyWithGovernanceTx(
  config: SuiAgentRegistryConfig,
  agentType: AgentType,
  jurisdiction: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::register_empty_with_governance`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.pure.u8(agentType),
      tx.pure.string(jurisdiction),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Update the agent's OpenEAGO classification type.
 * Calls `identity_registry::set_agent_type`.
 */
export function buildSetAgentTypeTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  agentType: AgentType,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_agent_type`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.u8(agentType),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Update the agent's jurisdiction string.
 * Calls `identity_registry::set_jurisdiction`.
 */
export function buildSetJurisdictionTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  jurisdiction: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_jurisdiction`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(jurisdiction),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Transition the agent lifecycle state.
 * Calls `identity_registry::update_lifecycle_state`.
 *
 * Terminal states (Revoked=2, Archived=3) cannot be left — the on-chain
 * function will abort if you attempt it.
 */
export function buildUpdateLifecycleStateTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  newState: LifecycleState,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::update_lifecycle_state`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.u8(newState),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Declare or update a skill on an agent.
 * Calls `identity_registry::set_skill`.
 *
 * The skill is stored as a dynamic field keyed by `"eago:skill:{skillId}"`.
 */
export function buildSetSkillTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  skillId: string,
  skillCategory: string,
  domainCategory: string,
  proficiencyLevel: SkillProficiency,
  metadataUri: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_skill`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(skillId),
      tx.pure.string(skillCategory),
      tx.pure.string(domainCategory),
      tx.pure.u8(proficiencyLevel),
      tx.pure.string(metadataUri),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Remove a previously declared skill.
 * Calls `identity_registry::remove_skill`.
 */
export function buildRemoveSkillTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  skillId: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::remove_skill`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(skillId),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Assert a regulatory/compliance certification (e.g. "SOX", "GDPR", "HIPAA").
 * Calls `identity_registry::add_compliance_tag`.
 */
export function buildAddComplianceTagTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  tag: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::add_compliance_tag`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(tag),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Retract a compliance certification.
 * Calls `identity_registry::remove_compliance_tag`.
 */
export function buildRemoveComplianceTagTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  tag: string,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::remove_compliance_tag`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.string(tag),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Self-report SLA performance metrics aligned with OpenEAGO Appendix D.1.
 * Calls `identity_registry::update_sla_metrics`.
 *
 * All *Bps values are basis points (0–10 000).  The on-chain function will abort
 * if any value breaches the minimum performance bar:
 *   reliabilityBps ≥ 9500, uptimeBps ≥ 9900, errorRateBps ≤ 500.
 */
export function buildUpdateSlaMetricsTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  reliabilityBps: number,
  uptimeBps: number,
  errorRateBps: number,
  latencyP99Ms: number,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::update_sla_metrics`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.u64(reliabilityBps),
      tx.pure.u64(uptimeBps),
      tx.pure.u64(errorRateBps),
      tx.pure.u64(latencyP99Ms),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Set the agent's risk tier (low=0, medium=1, high=2, critical=3).
 * Calls `identity_registry::set_risk_tier`.
 */
export function buildSetRiskTierTx(
  config: SuiAgentRegistryConfig,
  agentCapId: string,
  riskTier: RiskTier,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::identity_registry::set_risk_tier`,
    arguments: [
      tx.object(config.registryObjectIds.identity),
      tx.object(agentCapId),
      tx.pure.u8(riskTier),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function extractFields(resp: SuiObjectResponse): Record<string, unknown> | null {
  const content = resp.data?.content;
  if (!content || content.dataType !== "moveObject") return null;
  return content.fields as Record<string, unknown>;
}

function parseAgentEntry(
  resp: SuiObjectResponse,
  config: SuiAgentRegistryConfig,
  agentId: number
): AgentEntry | null {
  const fields = extractFields(resp);
  if (!fields) return null;

  return {
    agentId,
    globalId: buildGlobalId(config.network, config.registryObjectIds.identity, agentId),
    owner: String(fields["owner"] ?? ""),
    agentUri: String(fields["agent_uri"] ?? ""),
    active: Boolean(fields["active"]),
    createdAt: Number(fields["created_at"] ?? 0),
    updatedAt: Number(fields["updated_at"] ?? 0),
    // OpenEAGO governance fields
    agentType: Number(fields["agent_type"] ?? AgentType.Framework) as AgentType,
    jurisdiction: String(fields["jurisdiction"] ?? ""),
    lifecycleState: Number(fields["lifecycle_state"] ?? LifecycleState.Active) as LifecycleState,
  };
}
