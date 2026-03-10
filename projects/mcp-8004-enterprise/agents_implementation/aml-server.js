/**
 * aml-server.js
 *
 * MCP server for the BankAMLAgent card.
 * Implements tools from agents/mcp/aml-review.mcp.json.
 *
 * Usage (via launch-agents.js):
 *   node aml-server.js <path-to-agent-card.json> <port>
 *
 * Stub: screen_client and continue_screening return deterministic hashes
 * derived from the flow_id. Replace the handler bodies with real LLM calls
 * or AML provider API calls in production.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

// ── Stub helpers ───────────────────────────────────────────────────────────────

function stubResultHash(flowId, suffix) {
  return ethers.keccak256(ethers.toUtf8Bytes(`aml-result:${flowId}:${suffix}`));
}

function stubSpecHash(flowId, round) {
  return ethers.keccak256(ethers.toUtf8Bytes(`aml-doc-spec:${flowId}:round${round}`));
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const tools = {

  screen_client: {
    description: 'Initiate AML screening for a new onboarding client.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:         { type: 'string' },
        request_id:      { type: 'string' },
        client_agent_id: { type: 'string' },
        trace_id:        { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'client_agent_id'],
    },
    handler({ flow_id, request_id, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[aml-server] [${trace_id ?? 'n/a'}] screen_client flow=${flow_id}`);

      // Stub: always submit recommendation (cleared) without requesting docs.
      // In production: call AML provider, check sanctions lists, assess risk.
      return {
        action:      'submit_recommendation',
        result_hash: stubResultHash(flow_id, 'initial'),
        cleared:     true,
      };
    },
  },

  continue_screening: {
    description: 'Resume AML screening after client documents have been submitted.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string' },
        request_id: { type: 'string' },
        data_hash:  { type: 'string' },
        round:      { type: 'integer' },
        trace_id:   { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'data_hash'],
    },
    handler({ flow_id, data_hash, round, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[aml-server] [${trace_id ?? 'n/a'}] continue_screening flow=${flow_id} round=${round ?? 1} data=${data_hash}`);

      return {
        action:      'submit_recommendation',
        result_hash: stubResultHash(flow_id, `round${round ?? 1}`),
        cleared:     true,
      };
    },
  },
};

// ── Resources ─────────────────────────────────────────────────────────────────

const screeningStatus = new Map();

const resources = [
  {
    uri:         'aml://{flow_id}/status',
    name:        'AML Screening Status',
    description: 'Current status of the AML screening for a flow.',
    mimeType:    'application/json',
    _resolve(uri) {
      const m = uri.match(/^aml:\/\/(.+)\/status$/);
      if (!m) return null;
      return { uri, mimeType: 'application/json', text: JSON.stringify(screeningStatus.get(m[1]) ?? { status: 'not_started' }) };
    },
  },
];

// ── Prompts ───────────────────────────────────────────────────────────────────

const prompts = {
  aml_screening: {
    description: 'AML screening prompt for institutional client onboarding.',
    arguments: [
      { name: 'client_name',  description: 'Legal name of the institutional client', required: true },
      { name: 'jurisdiction', description: "Client jurisdiction",                    required: false },
    ],
    template({ client_name, jurisdiction }) {
      return [{
        role: 'system',
        content:
          `You are an AML compliance officer performing sanctions and PEP screening.\n\n` +
          `Client: ${client_name}${jurisdiction ? `\nJurisdiction: ${jurisdiction}` : ''}\n\n` +
          `Screen this client against all applicable sanctions lists and PEP databases.\n` +
          `Assess beneficial ownership structure and source of funds.\n` +
          `Provide a recommendation: CLEARED or REQUIRES_REVIEW, with justification.`,
      }];
    },
  },
};

// ── Start ─────────────────────────────────────────────────────────────────────

startMcpServer({ tools, resources, prompts, serverLabel: 'aml-server' });
