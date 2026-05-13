/**
 * SuiAgentRegistryClient — high-level entry point for the SUI Agentic Registry SDK.
 *
 * Usage:
 * ```ts
 * import { SuiAgentRegistryClient } from "@sui-a2a/registry-sdk";
 *
 * const client = new SuiAgentRegistryClient({
 *   rpcUrl: "https://fullnode.testnet.sui.io:443",
 *   network: "testnet",
 *   packageId: "0x<package>",
 *   registryObjectIds: {
 *     identity:   "0x<identity_registry>",
 *     reputation: "0x<reputation_registry>",
 *     validation: "0x<validation_registry>",
 *   },
 * });
 *
 * // Read an agent
 * const agent = await client.getAgent(0);
 *
 * // Build a registration transaction and sign/execute it with your wallet
 * const tx = client.buildRegisterTx("ipfs://Qm...");
 * const result = await signer.signAndExecuteTransaction({ transaction: tx });
 * ```
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type {
  AgentEntry,
  FeedbackRecord,
  FeedbackSummary,
  GiveFeedbackParams,
  RequestValidationParams,
  RespondValidationParams,
  SuiAgentRegistryConfig,
  ValidationEntry,
  ValidationSummary,
} from "./types.js";
import {
  buildGlobalId,
  buildRegisterTx,
  buildRegisterEmptyTx,
  buildSetAgentUriTx,
  buildSetAgentWalletTx,
  buildUnsetAgentWalletTx,
  buildSetMetadataTx,
  getAgent,
  getAgentCount,
} from "./identity.js";
import {
  buildGiveFeedbackTx,
  buildRevokeFeedbackTx,
  buildAppendResponseTx,
  readFeedback,
  getReputationSummary,
} from "./reputation.js";
import {
  buildValidationRequestTx,
  buildValidationResponseTx,
  getValidationStatus,
  getAgentValidationSummary,
  getAgentValidationHashes,
} from "./validation.js";

export class SuiAgentRegistryClient {
  private readonly suiClient: SuiClient;
  private readonly config: SuiAgentRegistryConfig;

  constructor(config: SuiAgentRegistryConfig) {
    this.config = config;
    this.suiClient = new SuiClient({ url: config.rpcUrl });
  }

  // ─── Utility ────────────────────────────────────────────────────────────────

  /** Build the global agent ID: `sui:{network}:{registryObjectId}:{agentId}` */
  globalId(agentId: number): string {
    return buildGlobalId(
      this.config.network,
      this.config.registryObjectIds.identity,
      agentId
    );
  }

  // ─── Identity — Reads ────────────────────────────────────────────────────────

  async getAgent(agentId: number): Promise<AgentEntry | null> {
    return getAgent(this.suiClient, this.config, agentId);
  }

  async getAgentCount(): Promise<number> {
    return getAgentCount(this.suiClient, this.config);
  }

  // ─── Identity — Transaction builders ────────────────────────────────────────

  buildRegisterTx(agentUri: string, clockObjectId?: string): Transaction {
    return buildRegisterTx(this.config, agentUri, clockObjectId);
  }

  buildRegisterEmptyTx(clockObjectId?: string): Transaction {
    return buildRegisterEmptyTx(this.config, clockObjectId);
  }

  buildSetAgentUriTx(
    agentCapId: string,
    newUri: string,
    clockObjectId?: string
  ): Transaction {
    return buildSetAgentUriTx(this.config, agentCapId, newUri, clockObjectId);
  }

  buildSetAgentWalletTx(
    agentCapId: string,
    newWallet: string,
    clockObjectId?: string
  ): Transaction {
    return buildSetAgentWalletTx(this.config, agentCapId, newWallet, clockObjectId);
  }

  buildUnsetAgentWalletTx(
    agentCapId: string,
    clockObjectId?: string
  ): Transaction {
    return buildUnsetAgentWalletTx(this.config, agentCapId, clockObjectId);
  }

  buildSetMetadataTx(
    agentCapId: string,
    key: string,
    value: Uint8Array,
    clockObjectId?: string
  ): Transaction {
    return buildSetMetadataTx(this.config, agentCapId, key, value, clockObjectId);
  }

  // ─── Reputation — Transaction builders ──────────────────────────────────────

  buildGiveFeedbackTx(
    params: GiveFeedbackParams,
    clockObjectId?: string
  ): Transaction {
    return buildGiveFeedbackTx(this.config, params, clockObjectId);
  }

  buildRevokeFeedbackTx(agentId: number, feedbackIndex: number): Transaction {
    return buildRevokeFeedbackTx(this.config, agentId, feedbackIndex);
  }

  buildAppendResponseTx(
    agentId: number,
    clientAddress: string,
    feedbackIndex: number,
    responseUri: string,
    responseHash: Uint8Array
  ): Transaction {
    return buildAppendResponseTx(
      this.config,
      agentId,
      clientAddress,
      feedbackIndex,
      responseUri,
      responseHash
    );
  }

  // ─── Reputation — Reads ──────────────────────────────────────────────────────

  async readFeedback(
    agentId: number,
    clientAddress: string,
    feedbackIndex: number
  ): Promise<FeedbackRecord | null> {
    return readFeedback(
      this.suiClient,
      this.config,
      agentId,
      clientAddress,
      feedbackIndex
    );
  }

  async getReputationSummary(
    agentId: number,
    filterTag1?: string
  ): Promise<FeedbackSummary> {
    return getReputationSummary(this.suiClient, this.config, agentId, filterTag1);
  }

  // ─── Validation — Transaction builders ──────────────────────────────────────

  buildValidationRequestTx(
    params: RequestValidationParams,
    clockObjectId?: string
  ): Transaction {
    return buildValidationRequestTx(this.config, params, clockObjectId);
  }

  buildValidationResponseTx(
    params: RespondValidationParams,
    clockObjectId?: string
  ): Transaction {
    return buildValidationResponseTx(this.config, params, clockObjectId);
  }

  // ─── Validation — Reads ──────────────────────────────────────────────────────

  async getValidationStatus(
    requestHash: string | Uint8Array
  ): Promise<ValidationEntry | null> {
    return getValidationStatus(this.suiClient, this.config, requestHash);
  }

  async getAgentValidationSummary(
    agentId: number,
    filterValidator?: string,
    filterTag?: string
  ): Promise<ValidationSummary> {
    return getAgentValidationSummary(
      this.suiClient,
      this.config,
      agentId,
      filterValidator,
      filterTag
    );
  }

  async getAgentValidationHashes(agentId: number): Promise<string[]> {
    return getAgentValidationHashes(this.suiClient, this.config, agentId);
  }
}
