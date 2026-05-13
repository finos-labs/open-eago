/**
 * Validation Registry helpers — read and write wrappers for validation_registry.move
 */
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import type {
  RequestValidationParams,
  RespondValidationParams,
  SuiAgentRegistryConfig,
  ValidationEntry,
  ValidationSummary,
} from "./types.js";

// ─── PTB builders ─────────────────────────────────────────────────────────────

/**
 * Build a PTB to request validation from a specific validator.
 */
export function buildValidationRequestTx(
  config: SuiAgentRegistryConfig,
  params: RequestValidationParams,
  clockObjectId = "0x6"
): Transaction {
  const hashBytes =
    typeof params.requestHash === "string"
      ? hexToBytes(params.requestHash)
      : params.requestHash;

  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::validation_registry::validation_request`,
    arguments: [
      tx.object(config.registryObjectIds.validation),
      tx.object(config.registryObjectIds.identity),
      tx.object(params.capObjectId),
      tx.pure.address(params.validatorAddress),
      tx.pure.string(params.requestUri),
      tx.pure.vector("u8", Array.from(hashBytes)),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

/**
 * Build a PTB to submit a validation response (0–100 score).
 */
export function buildValidationResponseTx(
  config: SuiAgentRegistryConfig,
  params: RespondValidationParams,
  clockObjectId = "0x6"
): Transaction {
  const hashBytes =
    typeof params.requestHash === "string"
      ? hexToBytes(params.requestHash)
      : params.requestHash;

  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::validation_registry::validation_response`,
    arguments: [
      tx.object(config.registryObjectIds.validation),
      tx.pure.vector("u8", Array.from(hashBytes)),
      tx.pure.u8(params.response),
      tx.pure.string(params.responseUri ?? ""),
      tx.pure.vector("u8", Array.from(params.responseHash ?? new Uint8Array(0))),
      tx.pure.string(params.tag ?? ""),
      tx.object(clockObjectId),
    ],
  });
  return tx;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

/**
 * Retrieve validation status for a given request_hash from emitted events.
 */
export async function getValidationStatus(
  client: SuiClient,
  config: SuiAgentRegistryConfig,
  requestHash: string | Uint8Array
): Promise<ValidationEntry | null> {
  const hashHex =
    requestHash instanceof Uint8Array ? bytesToHex(requestHash) : requestHash;

  // Search ValidationResponded events for the matching hash
  const events = await client.queryEvents({
    query: {
      MoveEventType: `${config.packageId}::validation_registry::ValidationResponded`,
    },
    limit: 100,
  });

  // Find the most recent response for this hash
  let latest: ValidationEntry | null = null;
  for (const ev of events.data) {
    const f = ev.parsedJson as Record<string, unknown> | undefined;
    if (!f) continue;
    const evHash = arrayToHex(f["request_hash"] as unknown[] | undefined);
    if (evHash !== hashHex) continue;

    const entry: ValidationEntry = {
      validatorAddress: String(f["validator_address"] ?? ""),
      agentId: Number(f["agent_id"] ?? 0),
      response: Number(f["response"] ?? 0),
      responseHash: hexToBytes(
        arrayToHex(f["response_hash"] as unknown[] | undefined)
      ),
      tag: String(f["tag"] ?? ""),
      lastUpdate: Number(ev.timestampMs ?? 0),
      responded: true,
    };
    if (!latest || entry.lastUpdate > latest.lastUpdate) {
      latest = entry;
    }
  }

  // If no response yet, look in ValidationRequested events
  if (!latest) {
    const reqEvents = await client.queryEvents({
      query: {
        MoveEventType: `${config.packageId}::validation_registry::ValidationRequested`,
      },
      limit: 100,
    });
    for (const ev of reqEvents.data) {
      const f = ev.parsedJson as Record<string, unknown> | undefined;
      if (!f) continue;
      const evHash = arrayToHex(f["request_hash"] as unknown[] | undefined);
      if (evHash !== hashHex) continue;
      latest = {
        validatorAddress: String(f["validator_address"] ?? ""),
        agentId: Number(f["agent_id"] ?? 0),
        response: 0,
        responseHash: new Uint8Array(0),
        tag: "",
        lastUpdate: Number(ev.timestampMs ?? 0),
        responded: false,
      };
      break;
    }
  }

  return latest;
}

/**
 * Aggregate all validation responses for an agent from events.
 */
export async function getAgentValidationSummary(
  client: SuiClient,
  config: SuiAgentRegistryConfig,
  agentId: number,
  filterValidator?: string,
  filterTag?: string
): Promise<ValidationSummary> {
  const events = await client.queryEvents({
    query: {
      MoveEventType: `${config.packageId}::validation_registry::ValidationResponded`,
    },
    limit: 100,
  });

  let count = 0;
  let total = 0;

  for (const ev of events.data) {
    const f = ev.parsedJson as Record<string, unknown> | undefined;
    if (!f) continue;
    if (Number(f["agent_id"]) !== agentId) continue;
    if (filterValidator && f["validator_address"] !== filterValidator) continue;
    if (filterTag && f["tag"] !== filterTag) continue;
    count++;
    total += Number(f["response"] ?? 0);
  }

  return {
    count,
    averageResponse: count === 0 ? 0 : Math.round(total / count),
  };
}

/**
 * Return all request hashes for which a given agent has requested validation.
 */
export async function getAgentValidationHashes(
  client: SuiClient,
  config: SuiAgentRegistryConfig,
  agentId: number
): Promise<string[]> {
  const events = await client.queryEvents({
    query: {
      MoveEventType: `${config.packageId}::validation_registry::ValidationRequested`,
    },
    limit: 100,
  });

  const hashes: string[] = [];
  for (const ev of events.data) {
    const f = ev.parsedJson as Record<string, unknown> | undefined;
    if (!f) continue;
    if (Number(f["agent_id"]) !== agentId) continue;
    hashes.push(arrayToHex(f["request_hash"] as unknown[] | undefined));
  }
  return hashes;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function arrayToHex(arr: unknown[] | undefined): string {
  if (!arr) return "";
  return arr.map((b) => Number(b).toString(16).padStart(2, "0")).join("");
}
