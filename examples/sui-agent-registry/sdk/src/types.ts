/**
 * Core types for the SUI Agentic Registry SDK.
 *
 * Modelled after ERC-8004 (Trustless Agents) with SUI-native extensions.
 * AgentRegistrationFile extends the Google A2A AgentCard format.
 * OpenEAGO governance fields added per https://github.com/finos-labs/open-eago.
 */

// ─── Registry configuration ───────────────────────────────────────────────────

export interface RegistryObjectIds {
  /** Object ID of the shared AgentRegistry (Identity Registry) */
  identity: string;
  /** Object ID of the shared ReputationRegistry */
  reputation: string;
  /** Object ID of the shared ValidationRegistry */
  validation: string;
}

export interface SuiAgentRegistryConfig {
  /** SUI RPC endpoint URL */
  rpcUrl: string;
  /** Network name for global ID construction: "mainnet" | "testnet" | "devnet" | "localnet" */
  network: string;
  /** Registry object IDs on the chosen network */
  registryObjectIds: RegistryObjectIds;
  /** Optional: module package ID (needed for PTB calls) */
  packageId?: string;
}

// ─── OpenEAGO governance enumerations ────────────────────────────────────────

/**
 * Agent type classification per OpenEAGO §3 (overview.md).
 * Maps to the `agent_type: u8` field on AgentEntry.
 */
export enum AgentType {
  /** LangChain, LangGraph, AutoGPT, custom ML frameworks */
  Framework = 0,
  /** KYC/AML, risk assessment, compliance validation, data classification */
  Core = 1,
  /** FX conversion, address standardisation, translation, encryption */
  Utility = 2,
  /** Orchestration of complex multi-agent workflows */
  Flow = 3,
}

/**
 * Agent lifecycle state per OpenEAGO identity.md state machine.
 * Maps to the `lifecycle_state: u8` field on AgentEntry.
 */
export enum LifecycleState {
  /** Authorised for runtime interactions */
  Active = 0,
  /** Temporarily blocked pending policy / security review */
  Suspended = 1,
  /** Permanently invalidated (terminal) */
  Revoked = 2,
  /** Retained for audit but excluded from runtime (terminal) */
  Archived = 3,
}

/**
 * Risk tier per OpenEAGO SPECIFICATION.md Appendix E.2.
 * Derived from the composite_risk_score ∈ [0.0, 1.0].
 */
export enum RiskTier {
  /** composite_risk_score ∈ [0.00, 0.39] — standard monitoring */
  Low = 0,
  /** composite_risk_score ∈ [0.40, 0.59] — enhanced monitoring */
  Medium = 1,
  /** composite_risk_score ∈ [0.60, 0.79] — requires HITL approval */
  High = 2,
  /** composite_risk_score ∈ [0.80, 1.00] — automatic rejection */
  Critical = 3,
}

/**
 * Skill proficiency level per OpenEAGO identity.md §Step 2.
 */
export enum SkillProficiency {
  Beginner = 0,
  Intermediate = 1,
  Advanced = 2,
  Expert = 3,
}

// ─── OpenEAGO SLA metrics ─────────────────────────────────────────────────────

/**
 * Self-reported SLA performance metrics aligned with OpenEAGO Appendix D.1.
 * All *_bps values are basis points (0–10 000; e.g. 9900 = 99.00%).
 */
export interface SlaMetrics {
  /** Rolling reliability in bps. OpenEAGO minimum: ≥ 9500 */
  reliabilityBps: number;
  /** Rolling uptime in bps. OpenEAGO minimum: ≥ 9900 */
  uptimeBps: number;
  /** Rolling error rate in bps. OpenEAGO maximum: ≤ 500 */
  errorRateBps: number;
  /** p99 latency in milliseconds */
  latencyP99Ms: number;
  /** Timestamp (ms) of the last update */
  lastUpdated: number;
}

/** Parameters for update_sla_metrics transactions */
export interface UpdateSlaMetricsParams {
  agentId: number;
  capObjectId: string;
  reliabilityBps: number;
  uptimeBps: number;
  errorRateBps: number;
  latencyP99Ms: number;
}

// ─── OpenEAGO skill declarations ─────────────────────────────────────────────

/**
 * A skill record stored on-chain as a dynamic field.
 * Mirrors the OASF-aligned skill definition from OpenEAGO identity.md §Step 2.
 */
export interface SkillRecord {
  skillId: string;
  skillCategory: string;
  domainCategory: string;
  proficiencyLevel: SkillProficiency;
  /** URI to extended skill metadata / OASF schema record */
  metadataUri: string;
}

/** Parameters for set_skill transactions */
export interface SetSkillParams {
  agentId: number;
  capObjectId: string;
  skillId: string;
  skillCategory: string;
  domainCategory: string;
  proficiencyLevel: SkillProficiency;
  metadataUri?: string;
}

/** Parameters for governance registration */
export interface RegisterWithGovernanceParams {
  agentUri: string;
  agentType: AgentType;
  jurisdiction: string;
}

// ─── On-chain agent data ──────────────────────────────────────────────────────

/**
 * Mirrors AgentEntry from the Move contract.
 * `agentId` follows ERC-8004 numeric ID convention.
 * `globalId` = `sui:{network}:{registryObjectId}:{agentId}`
 * OpenEAGO governance fields included.
 */
export interface AgentEntry {
  agentId: number;
  globalId: string;
  owner: string;
  agentUri: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  agentWallet?: string;
  // OpenEAGO governance fields
  /** Agent classification (framework=0, core=1, utility=2, flow=3) */
  agentType: AgentType;
  /** Jurisdiction string, e.g. "US-EAST", "EU", "APAC" */
  jurisdiction: string;
  /** Lifecycle state (active=0, suspended=1, revoked=2, archived=3) */
  lifecycleState: LifecycleState;
  /** Risk tier if set (low=0, medium=1, high=2, critical=3) */
  riskTier?: RiskTier;
  /** SLA metrics if self-reported */
  slaMetrics?: SlaMetrics;
}

// ─── Feedback / Reputation ────────────────────────────────────────────────────

/**
 * A single feedback record returned from read_feedback.
 * Signed values: `valueNegative=true` means the stored value is negative.
 */
export interface FeedbackRecord {
  agentId: number;
  clientAddress: string;
  feedbackIndex: number;
  valueNegative: boolean;
  valueMagnitude: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  isRevoked: boolean;
  createdAt: number;
}

export interface FeedbackSummary {
  count: number;
  /** Sum of positive feedback magnitudes */
  positiveSum: bigint;
  /** Sum of negative feedback magnitudes */
  negativeSum: bigint;
}

export interface GiveFeedbackParams {
  agentId: number;
  /** true = negative value (score is –valueMagnitude) */
  valueNegative: boolean;
  valueMagnitude: bigint;
  valueDecimals: number;
  tag1?: string;
  tag2?: string;
  endpoint?: string;
  feedbackUri?: string;
  feedbackHash?: Uint8Array;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationEntry {
  validatorAddress: string;
  agentId: number;
  /** 0 = not yet responded / failed, 100 = passed, intermediate = partial */
  response: number;
  responseHash: Uint8Array;
  tag: string;
  lastUpdate: number;
  responded: boolean;
}

export interface ValidationSummary {
  count: number;
  averageResponse: number;
}

export interface RequestValidationParams {
  agentId: number;
  capObjectId: string;
  validatorAddress: string;
  requestUri: string;
  /** sha3_256 hash of the request payload as hex string or Uint8Array */
  requestHash: string | Uint8Array;
}

export interface RespondValidationParams {
  requestHash: string | Uint8Array;
  /** 0–100 */
  response: number;
  responseUri?: string;
  responseHash?: Uint8Array;
  tag?: string;
}

// ─── Agent Registration File (extends A2A AgentCard) ─────────────────────────

/**
 * Service endpoint entry. Compatible with ERC-8004 registration file format.
 * Examples: A2A, MCP, OASF, ENS, DID, email, web
 */
export interface AgentService {
  name: string;
  endpoint: string;
  version?: string;
  /** OASF skill identifiers (optional) */
  skills?: string[];
  /** OASF domain identifiers (optional) */
  domains?: string[];
}

/**
 * On-chain registration back-reference.
 * Format: `sui:{network}:{registryObjectId}:{agentId}`
 */
export interface AgentRegistrationRef {
  agentId: number;
  agentRegistry: string;
}

/**
 * A2A AgentCard extended with ERC-8004 and OpenEAGO governance fields.
 *
 * Spec: https://google.github.io/A2A/specification/#55-agent-card
 * + ERC-8004 registration file extensions
 * + OpenEAGO governance extensions (https://github.com/finos-labs/open-eago)
 */
export interface AgentRegistrationFile {
  /** MUST: registration file type discriminator */
  type: string;
  /** MUST: human-readable agent name */
  name: string;
  /** MUST: natural-language description */
  description: string;
  /** SHOULD: image URL */
  image?: string;

  // ── A2A AgentCard fields ──────────────────────────────────────────────────

  /** Semantic version of the agent software */
  version: string;
  /** Primary agent URL (e.g. A2A base URL) */
  url: string;
  /** A2A capability flags */
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  /** A2A agent skills */
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    examples?: string[];
    inputModes?: string[];
    outputModes?: string[];
  }>;
  /** A2A default input content types */
  defaultInputModes?: string[];
  /** A2A default output content types */
  defaultOutputModes?: string[];

  // ── ERC-8004 registry extensions ─────────────────────────────────────────

  /** List of service endpoints: A2A, MCP, OASF, DID, ENS, email, web… */
  services?: AgentService[];
  /** Back-references to on-chain registrations */
  registrations?: AgentRegistrationRef[];
  /** Supported trust models: "reputation" | "crypto-economic" | "tee-attestation" */
  supportedTrust?: string[];
  /** Whether the agent is currently active */
  active?: boolean;

  // ── OpenEAGO governance extensions ───────────────────────────────────────

  /** OpenEAGO agent classification (framework / core / utility / flow) */
  agentType?: AgentType;
  /** Jurisdiction, e.g. "US-EAST", "EU", "APAC" (OpenEAGO cross-border governance) */
  jurisdiction?: string;
  /** Regulatory/compliance certifications declared, e.g. ["SOX", "GDPR", "HIPAA"] */
  complianceTags?: string[];
  /** OpenEAGO lifecycle state */
  lifecycleState?: LifecycleState;
  /** Risk tier (derived from OpenEAGO composite_risk_score) */
  riskTier?: RiskTier;
  /** OASF-aligned skill declarations */
  oasfSkills?: SkillRecord[];
  /** Self-reported SLA metrics (OpenEAGO Appendix D.1) */
  slaMetrics?: SlaMetrics;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoverFilter {
  capabilityCodes?: string[];
  /** Filter by compliance tags (e.g. ["SOX", "GDPR"]) — OpenEAGO cross-border governance */
  compliance?: string[];
  /** Filter by jurisdiction string (OpenEAGO Phase 2 data-residency check) */
  jurisdiction?: string;
  minReliability?: number;
  minUptimePct?: number;
  maxLatencyP99Ms?: number;
  excludeStatus?: string[];
  tags?: string[];
  /** Filter by OpenEAGO agent type */
  agentType?: AgentType;
  /** Exclude agents above this risk tier (OpenEAGO Appendix E.2) */
  maxRiskTier?: RiskTier;
  /** Exclude agents whose lifecycle state is not Active */
  onlyActive?: boolean;
}

export interface DiscoverResult {
  count: number;
  filteredOut: number;
  agents: AgentEntry[];
}
