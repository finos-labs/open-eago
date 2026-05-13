/**
 * Configuration loader — reads config.yaml and merges with environment variables.
 *
 * Environment variable overrides (all optional):
 *   SUI_RPC_URL           → sui.rpc_url
 *   SUI_NETWORK           → sui.network
 *   REGISTRY_PACKAGE_ID   → registry.package_id
 *   IDENTITY_OBJECT_ID    → registry.identity_object_id
 *   REPUTATION_OBJECT_ID  → registry.reputation_object_id
 *   VALIDATION_OBJECT_ID  → registry.validation_object_id
 *   SERVER_PORT           → server.port
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface ServerConfig {
  sui: {
    rpcUrl: string;
    network: string;
  };
  registry: {
    packageId: string;
    identityObjectId: string;
    reputationObjectId: string;
    validationObjectId: string;
  };
  server: {
    port: number;
    host: string;
    swagger: boolean;
    swaggerPath: string;
  };
  sync: {
    pollIntervalMs: number;
    eventsLimit: number;
  };
}

interface RawConfig {
  sui?: { rpc_url?: string; network?: string };
  registry?: {
    package_id?: string;
    identity_object_id?: string;
    reputation_object_id?: string;
    validation_object_id?: string;
  };
  server?: { port?: number; host?: string; swagger?: boolean; swagger_path?: string };
  sync?: { poll_interval_ms?: number; events_limit?: number };
}

export function loadConfig(configPath?: string): ServerConfig {
  const filePath = configPath ?? resolve(process.cwd(), "config.yaml");

  let raw: RawConfig = {};
  try {
    const content = readFileSync(filePath, "utf8");
    raw = yaml.load(content) as RawConfig;
  } catch {
    console.warn(`[config] Could not read ${filePath}, using defaults + env vars`);
  }

  return {
    sui: {
      rpcUrl:
        process.env["SUI_RPC_URL"] ??
        raw.sui?.rpc_url ??
        "https://fullnode.testnet.sui.io:443",
      network: process.env["SUI_NETWORK"] ?? raw.sui?.network ?? "testnet",
    },
    registry: {
      packageId: process.env["REGISTRY_PACKAGE_ID"] ?? raw.registry?.package_id ?? "0x0",
      identityObjectId:
        process.env["IDENTITY_OBJECT_ID"] ?? raw.registry?.identity_object_id ?? "0x0",
      reputationObjectId:
        process.env["REPUTATION_OBJECT_ID"] ?? raw.registry?.reputation_object_id ?? "0x0",
      validationObjectId:
        process.env["VALIDATION_OBJECT_ID"] ?? raw.registry?.validation_object_id ?? "0x0",
    },
    server: {
      port: Number(process.env["SERVER_PORT"] ?? raw.server?.port ?? 3000),
      host: raw.server?.host ?? "0.0.0.0",
      swagger: raw.server?.swagger ?? true,
      swaggerPath: raw.server?.swagger_path ?? "/docs",
    },
    sync: {
      pollIntervalMs: raw.sync?.poll_interval_ms ?? 30_000,
      eventsLimit: raw.sync?.events_limit ?? 200,
    },
  };
}
