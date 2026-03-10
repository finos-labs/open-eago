/**
 * action-gateway.js
 *
 * Runtime Action Gateway — Concept 10.
 *
 * Classifies tool invocation commands against the action-patterns catalogue
 * and validates action permits against the ActionPermitRegistry on-chain.
 *
 * Usage (from a bridge or MCP server):
 *
 *   import { ActionGateway } from './action-gateway.js';
 *
 *   const gateway = new ActionGateway({
 *     patternsPath: new URL('../agents_implementation/action-patterns.json', import.meta.url),
 *     mcpSpec:      parsedMcpSpec,           // optional: per-tool action_permits overrides
 *     registry:     ethersContractInstance,  // optional: ActionPermitRegistry on-chain
 *   });
 *
 *   // Classify a raw command string:
 *   const { patternId, actionType, tier } = gateway.classify('SELECT * FROM users');
 *
 *   // Validate a tool invocation before calling the external system:
 *   const ok = await gateway.validate(flowId, agentId, actionType);
 *   if (!ok) throw new Error(`action not permitted: ${patternId} (tier ${tier})`);
 *
 * The gateway also integrates with the MCP server's tools/list and tools/call
 * handlers to surface suspension state from bounds-state.json.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_PATTERNS_PATH = path.resolve(__dirname, 'action-patterns.json');

const ACTION_PERMIT_ABI = [
  'function validateAction(bytes32 flowId, uint256 agentId, bytes32 actionType) view returns (bool)',
  'function grantPermit(bytes32 flowId, uint256 agentId, bytes32 actionType, uint8 tier, uint256 requiredApprovals) external',
  'function approveAction(bytes32 flowId, uint256 agentId, bytes32 actionType) external',
  'function getPermit(bytes32 flowId, uint256 agentId, bytes32 actionType) view returns (bool exists, uint8 tier, bool approved, uint256 approvalCount, uint256 requiredApprovals)',
];

// ── Pattern loading ────────────────────────────────────────────────────────────

function loadPatterns(patternsPath) {
  const raw = JSON.parse(fs.readFileSync(patternsPath ?? DEFAULT_PATTERNS_PATH, 'utf8'));
  return (raw.patterns ?? []).map(p => ({
    id:    p.id,
    regex: new RegExp(p.regex, 'i'),
    tier:  p.tier,
    hash:  ethers.keccak256(ethers.toUtf8Bytes(p.id)),
  }));
}

// ── Classification ─────────────────────────────────────────────────────────────

/**
 * Classify a raw command string against the loaded patterns.
 *
 * @param {string} command  Raw command or action identifier to classify.
 * @param {Array}  patterns Compiled patterns from loadPatterns().
 * @returns {{ patternId: string, actionType: string, tier: number }}
 *           actionType is the keccak256 hash of the pattern id, suitable for
 *           passing to validateAction() on-chain.
 *           Returns tier 0 with id 'UNKNOWN' if no pattern matches.
 */
function classifyCommand(command, patterns) {
  let best = null;
  for (const p of patterns) {
    if (p.regex.test(command)) {
      if (!best || p.tier > best.tier) {
        best = p;
      }
    }
  }
  if (!best) {
    return {
      patternId:  'UNKNOWN',
      actionType: ethers.keccak256(ethers.toUtf8Bytes('UNKNOWN')),
      tier:       0,
    };
  }
  return { patternId: best.id, actionType: best.hash, tier: best.tier };
}

// ── Tier 2 approval polling ────────────────────────────────────────────────────

/**
 * Wait until a Tier 2 permit is resolved (approved or timed out).
 *
 * @param {object} registry    ethers.Contract for ActionPermitRegistry.
 * @param {string} flowId      bytes32 flow id.
 * @param {bigint} agentId     Agent id.
 * @param {string} actionType  bytes32 action type hash.
 * @param {number} timeoutMs   Maximum wait time in milliseconds.
 * @param {number} pollMs      Polling interval in milliseconds.
 * @returns {Promise<boolean>} true if approved before timeout, false otherwise.
 */
async function waitForApproval(registry, flowId, agentId, actionType, timeoutMs = 300_000, pollMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [exists, , approved] = await registry.getPermit(flowId, agentId, actionType);
    if (exists && approved) return true;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

// ── ActionGateway class ────────────────────────────────────────────────────────

export class ActionGateway {
  /**
   * @param {object} opts
   * @param {string}  [opts.patternsPath]  Absolute path to action-patterns.json.
   * @param {object}  [opts.mcpSpec]       Parsed MCP spec for per-tool action_permits.
   * @param {object}  [opts.registry]      ethers.Contract for ActionPermitRegistry (optional).
   * @param {number}  [opts.approvalTimeout] Tier 2 approval timeout in ms (default 300 000).
   */
  constructor({ patternsPath, mcpSpec, registry, approvalTimeout } = {}) {
    this.patterns        = loadPatterns(patternsPath);
    this.registry        = registry ?? null;
    this.approvalTimeout = approvalTimeout ?? 300_000;

    // Build per-tool overrides from action_permits blocks in MCP spec.
    this.toolPermits = {};
    if (mcpSpec?.tools) {
      for (const tool of mcpSpec.tools) {
        if (tool.action_permits) {
          this.toolPermits[tool.name] = tool.action_permits;
        }
      }
    }
  }

  /**
   * Classify a raw command string against the pattern catalogue.
   */
  classify(command) {
    return classifyCommand(command, this.patterns);
  }

  /**
   * Classify a tool invocation by its tool name.
   * The tool name is treated as the action identifier if it matches a pattern
   * directly (e.g. 'review_pr', 'approve_pr'), otherwise the command string
   * provided in `args` is classified.
   *
   * @param {string} toolName   MCP tool name.
   * @param {object} args       Tool invocation arguments (may contain 'command', 'query', etc.).
   * @returns {{ patternId, actionType, tier }}
   */
  classifyTool(toolName, args = {}) {
    // Check if the tool has an explicit action_permits.tool_action override.
    const permits = this.toolPermits[toolName];
    if (permits?.tool_action) {
      return classifyCommand(permits.tool_action, this.patterns);
    }
    // Try to match the tool name directly as a pattern.
    const byName = classifyCommand(toolName, this.patterns);
    if (byName.patternId !== 'UNKNOWN') return byName;
    // Fall back to classifying the command/query argument if present.
    const cmd = args.command ?? args.query ?? args.sql ?? '';
    return classifyCommand(cmd, this.patterns);
  }

  /**
   * Validate that an agent may perform an action in a flow.
   *
   * For Tier 3 (forbidden): immediately returns false.
   * For Tier 0 (read-only): returns true without an on-chain call.
   * For Tier 1/2: calls validateAction() on the ActionPermitRegistry.
   * For Tier 2 with a pending permit: polls until approved or timed out.
   *
   * @param {string} flowId      bytes32 flow id (hex string).
   * @param {bigint|string} agentId ERC-8004 agent id.
   * @param {string} actionType  bytes32 action type hash.
   * @param {number} tier        Action tier (from classify()).
   * @returns {Promise<boolean>}
   */
  async validate(flowId, agentId, actionType, tier) {
    if (tier === 3) return false;
    if (tier === 0) return true;

    if (!this.registry) {
      // No registry configured: opt-in default (permit).
      return true;
    }

    const permitted = await this.registry.validateAction(flowId, agentId, actionType);

    // For Tier 2, if the permit exists but is not yet approved, wait for multi-sig.
    if (!permitted && tier === 2) {
      const [exists, , approved] = await this.registry.getPermit(flowId, agentId, actionType);
      if (exists && !approved) {
        console.log(`[action-gateway] Tier 2 action pending approval — waiting up to ${this.approvalTimeout / 1000}s`);
        return waitForApproval(this.registry, flowId, agentId, actionType, this.approvalTimeout);
      }
    }

    return permitted;
  }

  /**
   * Full pipeline: classify a tool invocation then validate against the registry.
   *
   * @param {string}  toolName  MCP tool name.
   * @param {object}  args      Tool invocation arguments.
   * @param {string}  flowId    bytes32 flow id.
   * @param {bigint}  agentId   Agent id.
   * @returns {Promise<{ permitted: boolean, patternId: string, actionType: string, tier: number }>}
   */
  async checkTool(toolName, args, flowId, agentId) {
    const { patternId, actionType, tier } = this.classifyTool(toolName, args);
    const permitted = await this.validate(flowId, agentId, actionType, tier);
    return { permitted, patternId, actionType, tier };
  }
}

// ── Convenience factory using env / CLI args ──────────────────────────────────

/**
 * Create an ActionGateway from a CLI/env action permit registry address.
 *
 * @param {string|null} registryAddress   Hex address (or null to disable).
 * @param {object}      provider          ethers.Provider
 * @param {object}      [mcpSpec]         Parsed MCP spec.
 * @returns {ActionGateway}
 */
export function createGateway(registryAddress, provider, mcpSpec) {
  let registry = null;
  if (registryAddress) {
    registry = new ethers.Contract(registryAddress, ACTION_PERMIT_ABI, provider);
  }
  return new ActionGateway({ registry, mcpSpec });
}

export const ACTION_PERMIT_REGISTRY_ABI = ACTION_PERMIT_ABI;
