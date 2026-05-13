/**
 * Reputation Registry helpers — read and write wrappers for reputation_registry.move
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type {
  FeedbackRecord,
  FeedbackSummary,
  GiveFeedbackParams,
  SuiAgentRegistryConfig,
} from "./types.js";

// ─── PTB builders ─────────────────────────────────────────────────────────────

/**
 * Build a PTB transaction to give feedback about an agent.
 */
export function buildGiveFeedbackTx(
  config: SuiAgentRegistryConfig,
  params: GiveFeedbackParams,
  clockObjectId = "0x6"
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::reputation_registry::give_feedback`,
    arguments: [
      tx.object(config.registryObjectIds.reputation),
      tx.object(config.registryObjectIds.identity),
      tx.pure.u64(params.agentId),
      tx.pure.bool(params.valueNegative),
      tx.pure.u128(params.valueMagnitude),
      tx.pure.u8(params.valueDecimals),
      tx.pure.string(params.tag1 ?? ""),
      tx.pure.string(params.tag2 ?? ""),
      tx.pure.string(params.endpoint ?? ""),
      tx.pure.string(params.feedbackUri ?? ""),
      tx.pure.vector("u8", Array.from(params.feedbackHash ?? new Uint8Array(32))),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to revoke previously given feedback.
 */
export function buildRevokeFeedbackTx(
  config: SuiAgentRegistryConfig,
  agentId: number,
  feedbackIndex: number
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::reputation_registry::revoke_feedback`,
    arguments: [
      tx.object(config.registryObjectIds.reputation),
      tx.pure.u64(agentId),
      tx.pure.u64(feedbackIndex),
    ],
  });
  return tx;
}

/**
 * Build a PTB transaction to append a response/annotation to existing feedback.
 */
export function buildAppendResponseTx(
  config: SuiAgentRegistryConfig,
  agentId: number,
  clientAddress: string,
  feedbackIndex: number,
  responseUri: string,
  responseHash: Uint8Array
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::reputation_registry::append_response`,
    arguments: [
      tx.object(config.registryObjectIds.reputation),
      tx.pure.u64(agentId),
      tx.pure.address(clientAddress),
      tx.pure.u64(feedbackIndex),
      tx.pure.string(responseUri),
      tx.pure.vector("u8", Array.from(responseHash)),
    ],
  });
  return tx;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Read a single feedback record.
 * Note: on-chain feedback is keyed by a composite bytes key; the SDK fetches it
 * by querying the events emitted during `give_feedback` for the specific index.
 *
 * Full off-chain aggregation is recommended for production use — see server/.
 */
export async function readFeedback(
  client: SuiClient,
  config: SuiAgentRegistryConfig,
  agentId: number,
  clientAddress: string,
  feedbackIndex: number
): Promise<FeedbackRecord | null> {
  // Query NewFeedback events filtered by agent_id, client_address, feedback_index
  const events = await client.queryEvents({
    query: {
      MoveEventType: `${config.packageId}::reputation_registry::NewFeedback`,
    },
    limit: 50,
  });

  for (const ev of events.data) {
    const f = ev.parsedJson as Record<string, unknown> | undefined;
    if (!f) continue;
    if (
      Number(f["agent_id"]) === agentId &&
      String(f["client_address"]) === clientAddress &&
      Number(f["feedback_index"]) === feedbackIndex
    ) {
      return {
        agentId,
        clientAddress,
        feedbackIndex,
        valueNegative: Boolean(f["value_negative"]),
        valueMagnitude: BigInt(String(f["value_magnitude"] ?? "0")),
        valueDecimals: Number(f["value_decimals"] ?? 0),
        tag1: String(f["tag1"] ?? ""),
        tag2: String(f["tag2"] ?? ""),
        isRevoked: false, // revocation state must be checked separately via FeedbackRevoked events
        createdAt: Number(ev.timestampMs ?? 0),
      };
    }
  }
  return null;
}

/**
 * Compute an on-chain reputation summary for an agent by aggregating
 * NewFeedback and FeedbackRevoked events.
 *
 * This is a lightweight client-side summary. Production systems should use
 * the REST API server which maintains a pre-indexed event store.
 */
export async function getReputationSummary(
  client: SuiClient,
  config: SuiAgentRegistryConfig,
  agentId: number,
  filterTag1?: string
): Promise<FeedbackSummary> {
  const feedbackEvents = await client.queryEvents({
    query: {
      MoveEventType: `${config.packageId}::reputation_registry::NewFeedback`,
    },
    limit: 100,
  });

  const revokedEvents = await client.queryEvents({
    query: {
      MoveEventType: `${config.packageId}::reputation_registry::FeedbackRevoked`,
    },
    limit: 100,
  });

  // Build revoked set: "clientAddress:feedbackIndex"
  const revokedSet = new Set<string>();
  for (const ev of revokedEvents.data) {
    const f = ev.parsedJson as Record<string, unknown> | undefined;
    if (!f) continue;
    if (Number(f["agent_id"]) === agentId) {
      revokedSet.add(`${f["client_address"]}:${f["feedback_index"]}`);
    }
  }

  let count = 0;
  let positiveSum = 0n;
  let negativeSum = 0n;

  for (const ev of feedbackEvents.data) {
    const f = ev.parsedJson as Record<string, unknown> | undefined;
    if (!f) continue;
    if (Number(f["agent_id"]) !== agentId) continue;
    if (filterTag1 && f["tag1"] !== filterTag1) continue;
    const key = `${f["client_address"]}:${f["feedback_index"]}`;
    if (revokedSet.has(key)) continue;

    count++;
    const mag = BigInt(String(f["value_magnitude"] ?? "0"));
    if (f["value_negative"]) {
      negativeSum += mag;
    } else {
      positiveSum += mag;
    }
  }

  return { count, positiveSum, negativeSum };
}
