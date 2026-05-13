/**
 * RegistrySync — subscribes to SUI events from all three registries and
 * keeps the AgentStore up to date.
 *
 * On startup: queries historical events to populate the store.
 * Then: polls every `pollIntervalMs` milliseconds for new events.
 */
import { SuiClient } from "@mysten/sui/client";
import type { ServerConfig } from "./config.js";

// ─── AgentStore ───────────────────────────────────────────────────────────────

export type AgentStatus = "healthy" | "degraded" | "suspended" | "unknown";

export interface AgentRecord {
  agentId: number;
  globalId: string;
  owner: string;
  agentUri: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
  agentWallet?: string;
  capabilityCodes: string[];
  compliance: string[];
  jurisdiction: string;
  version: string;
  instanceId: string;
  reliability: number;
  uptimePct: number;
  feedbackCount: number;
  averageScore: number;
  slaLatencyP99Ms?: number;
  slaAvailabilityPct?: number;
  slaThroughputRps?: number;
  slaErrorRateMax?: number;
  status: AgentStatus;
}

function deriveStatus(record: AgentRecord): AgentStatus {
  if (!record.active) return "suspended";
  if (record.reliability < 0.85) return "degraded";
  return "healthy";
}

export class AgentStore {
  private agents = new Map<number, AgentRecord>();

  upsert(record: AgentRecord): void {
    record.status = deriveStatus(record);
    this.agents.set(record.agentId, record);
  }

  get(agentId: number): AgentRecord | undefined {
    return this.agents.get(agentId);
  }

  getAll(): AgentRecord[] {
    return Array.from(this.agents.values());
  }

  count(): number {
    return this.agents.size;
  }

  discover(filter: {
    capabilityCodes?: string[];
    compliance?: string[];
    jurisdiction?: string;
    minReliability?: number;
    minUptimePct?: number;
    maxLatencyP99Ms?: number;
    excludeStatus?: AgentStatus[];
    tags?: string[];
  }): { agents: AgentRecord[]; filteredOut: number } {
    const minRel = Math.max(filter.minReliability ?? 0, 0.95);
    const minUptime = Math.max(filter.minUptimePct ?? 0, 99.0);
    const all = this.getAll();
    const passed: AgentRecord[] = [];
    let filteredOut = 0;

    for (const agent of all) {
      let excluded = false;
      if (filter.excludeStatus?.includes(agent.status)) excluded = true;
      if (!excluded && filter.capabilityCodes?.length) {
        if (!filter.capabilityCodes.every((c) => agent.capabilityCodes.includes(c))) excluded = true;
      }
      if (!excluded && filter.compliance?.length) {
        if (!filter.compliance.every((c) => agent.compliance.includes(c))) excluded = true;
      }
      if (!excluded && filter.jurisdiction) {
        if (agent.jurisdiction !== filter.jurisdiction) excluded = true;
      }
      if (!excluded && agent.reliability < minRel) excluded = true;
      if (!excluded && agent.uptimePct < minUptime) excluded = true;
      if (!excluded && filter.maxLatencyP99Ms !== undefined && agent.slaLatencyP99Ms !== undefined) {
        if (agent.slaLatencyP99Ms > filter.maxLatencyP99Ms) excluded = true;
      }
      if (excluded) filteredOut++;
      else passed.push(agent);
    }
    return { agents: passed, filteredOut };
  }
}

// ─── RegistrySync ─────────────────────────────────────────────────────────────

export class RegistrySync {
  private readonly client: SuiClient;
  private readonly config: ServerConfig;
  private readonly store: AgentStore;
  private timer: NodeJS.Timeout | undefined;

  constructor(config: ServerConfig, store: AgentStore) {
    this.config = config;
    this.store = store;
    this.client = new SuiClient({ url: config.sui.rpcUrl });
  }

  /** Perform initial full sync then start polling. */
  async start(): Promise<void> {
    await this.sync();
    this.timer = setInterval(() => {
      this.sync().catch((err) =>
        console.error("[sync] polling error:", err)
      );
    }, this.config.sync.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Core sync logic ───────────────────────────────────────────────────────

  private async sync(): Promise<void> {
    const pkg = this.config.registry.packageId;
    if (!pkg || pkg === "0x0") {
      console.warn("[sync] packageId not configured, skipping event sync");
      return;
    }

    await Promise.all([
      this.syncIdentityEvents(pkg),
      this.syncReputationEvents(pkg),
    ]);
  }

  private async syncIdentityEvents(pkg: string): Promise<void> {
    await this.queryEvents(
      `${pkg}::identity_registry::AgentRegistered`,
      (f) => {
        const agentId = Number(f["agent_id"] ?? 0);
        const existing = this.store.get(agentId);
        const record: AgentRecord = {
          ...(existing ?? defaultRecord(agentId)),
          agentId,
          globalId: `sui:${this.config.sui.network}:${this.config.registry.identityObjectId}:${agentId}`,
          owner: String(f["owner"] ?? ""),
          agentUri: String(f["agent_uri"] ?? ""),
          active: true,
        };
        this.store.upsert(record);
      }
    );

    await this.queryEvents(
      `${pkg}::identity_registry::URIUpdated`,
      (f) => {
        const agentId = Number(f["agent_id"] ?? 0);
        const existing = this.store.get(agentId);
        if (existing) {
          existing.agentUri = String(f["new_uri"] ?? existing.agentUri);
          this.store.upsert(existing);
        }
      }
    );

    await this.queryEvents(
      `${pkg}::identity_registry::MetadataSet`,
      (f) => {
        const agentId = Number(f["agent_id"] ?? 0);
        const key = String(f["metadata_key"] ?? "");
        const existing = this.store.get(agentId);
        if (!existing) return;

        // Well-known metadata keys that the server understands
        if (key === "capabilityCodes") {
          try {
            existing.capabilityCodes = JSON.parse(String(f["value"] ?? "[]"));
          } catch { /* ignore */ }
        } else if (key === "compliance") {
          try {
            existing.compliance = JSON.parse(String(f["value"] ?? "[]"));
          } catch { /* ignore */ }
        } else if (key === "jurisdiction") {
          existing.jurisdiction = String(f["value"] ?? "");
        } else if (key === "slaGuarantees") {
          try {
            const sla = JSON.parse(String(f["value"] ?? "{}"));
            existing.slaLatencyP99Ms = sla.latency_p99_ms;
            existing.slaAvailabilityPct = sla.availability_pct;
            existing.slaThroughputRps = sla.throughput_rps;
            existing.slaErrorRateMax = sla.error_rate_max;
          } catch { /* ignore */ }
        } else if (key === "reliability") {
          existing.reliability = parseFloat(String(f["value"] ?? "0"));
        } else if (key === "uptimePct") {
          existing.uptimePct = parseFloat(String(f["value"] ?? "0"));
        }
        this.store.upsert(existing);
      }
    );
  }

  private async syncReputationEvents(pkg: string): Promise<void> {
    // Rebuild per-agent feedback counts from events
    const feedbackMap = new Map<number, { pos: bigint; neg: bigint; count: number }>();
    const revokedSet = new Set<string>();

    await this.queryEvents(
      `${pkg}::reputation_registry::FeedbackRevoked`,
      (f) => {
        const key = `${f["agent_id"]}:${f["client_address"]}:${f["feedback_index"]}`;
        revokedSet.add(key);
      }
    );

    await this.queryEvents(
      `${pkg}::reputation_registry::NewFeedback`,
      (f) => {
        const agentId = Number(f["agent_id"] ?? 0);
        const key = `${agentId}:${f["client_address"]}:${f["feedback_index"]}`;
        if (revokedSet.has(key)) return;

        const mag = BigInt(String(f["value_magnitude"] ?? "0"));
        const neg = Boolean(f["value_negative"]);
        const entry = feedbackMap.get(agentId) ?? { pos: 0n, neg: 0n, count: 0 };
        entry.count++;
        if (neg) entry.neg += mag;
        else entry.pos += mag;
        feedbackMap.set(agentId, entry);
      }
    );

    for (const [agentId, agg] of feedbackMap) {
      const existing = this.store.get(agentId);
      if (!existing) continue;
      const total = agg.pos - agg.neg;
      const avg = agg.count > 0 ? Number(total / BigInt(agg.count)) : 0;
      existing.feedbackCount = agg.count;
      existing.averageScore = Math.max(0, Math.min(100, avg));
      // Derive reliability from average score if not explicitly set
      if (existing.reliability === 0 && agg.count > 0) {
        existing.reliability = existing.averageScore / 100;
      }
      this.store.upsert(existing);
    }
  }

  // ─── Helper ────────────────────────────────────────────────────────────────

  private async queryEvents(
    eventType: string,
    handler: (fields: Record<string, unknown>) => void
  ): Promise<void> {
    try {
      const result = await this.client.queryEvents({
        query: { MoveEventType: eventType },
        limit: this.config.sync.eventsLimit,
      });
      for (const ev of result.data) {
        const f = ev.parsedJson as Record<string, unknown> | undefined;
        if (f) handler(f);
      }
    } catch (err) {
      console.error(`[sync] error querying ${eventType}:`, err);
    }
  }
}

function defaultRecord(agentId: number): AgentRecord {
  return {
    agentId,
    globalId: "",
    owner: "",
    agentUri: "",
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    capabilityCodes: [],
    compliance: [],
    jurisdiction: "",
    version: "",
    instanceId: "",
    reliability: 0,
    uptimePct: 0,
    feedbackCount: 0,
    averageScore: 0,
    status: "unknown",
  };
}
