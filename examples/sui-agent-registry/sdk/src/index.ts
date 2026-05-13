/**
 * @sui-a2a/registry-sdk — public API
 */
export { SuiAgentRegistryClient } from "./client.js";
export type {
  SuiAgentRegistryConfig,
  RegistryObjectIds,
  AgentEntry,
  FeedbackRecord,
  FeedbackSummary,
  GiveFeedbackParams,
  ValidationEntry,
  ValidationSummary,
  RequestValidationParams,
  RespondValidationParams,
  AgentRegistrationFile,
  AgentService,
  AgentRegistrationRef,
  DiscoverFilter,
  DiscoverResult,
  // OpenEAGO governance types
  SlaMetrics,
  SkillRecord,
  UpdateSlaMetricsParams,
  SetSkillParams,
  RegisterWithGovernanceParams,
} from "./types.js";
export {
  // OpenEAGO enumerations
  AgentType,
  LifecycleState,
  RiskTier,
  SkillProficiency,
} from "./types.js";
export {
  buildGlobalId,
  // OpenEAGO governance TX builders
  buildRegisterWithGovernanceTx,
  buildRegisterEmptyWithGovernanceTx,
  buildSetAgentTypeTx,
  buildSetJurisdictionTx,
  buildUpdateLifecycleStateTx,
  buildSetSkillTx,
  buildRemoveSkillTx,
  buildAddComplianceTagTx,
  buildRemoveComplianceTagTx,
  buildUpdateSlaMetricsTx,
  buildSetRiskTierTx,
} from "./identity.js";
