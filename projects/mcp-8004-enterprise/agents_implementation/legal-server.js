/**
 * legal-server.js
 *
 * MCP server for the BankLegalAgent card.
 * Implements tools from agents/mcp/legal-review.mcp.json.
 *
 * Stub: issues one draft, then accepts any markup and submits recommendation.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

function stubHash(prefix, flowId, suffix) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${prefix}:${flowId}:${suffix}`));
}

// Track per-flow draft rounds (in-memory)
const draftState = new Map(); // flowId → { round }

const tools = {

  issue_initial_draft: {
    description: 'Produce the initial contract draft for the client onboarding.',
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
    handler({ flow_id, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[legal-server] [${trace_id ?? 'n/a'}] issue_initial_draft flow=${flow_id}`);

      const round = 1;
      draftState.set(flow_id, { round });
      const draftHash = stubHash('legal-draft', flow_id, `round${round}`);
      return { draft_hash: draftHash, round };
    },
  },

  review_markup_and_respond: {
    description: 'Review the client markup and respond: revised draft or recommendation.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:     { type: 'string' },
        request_id:  { type: 'string' },
        markup_hash: { type: 'string' },
        round:       { type: 'integer' },
        trace_id:    { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'markup_hash', 'round'],
    },
    handler({ flow_id, markup_hash, round, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[legal-server] [${trace_id ?? 'n/a'}] review_markup flow=${flow_id} round=${round}`);

      // Stub: always accept markup and submit recommendation after first round
      const finalHash = stubHash('legal-final', flow_id, `round${round}`);
      return { action: 'submit_recommendation', final_hash: finalHash };
    },
  },
};

const resources = [
  {
    uri: 'legal://{flow_id}/draft/{round}', name: 'Contract Draft',
    description: 'Contract draft for a negotiation round.', mimeType: 'application/json',
    _resolve(uri) {
      const m = uri.match(/^legal:\/\/(.+)\/draft\/(\d+)$/);
      if (!m) return null;
      const hash = stubHash('legal-draft', m[1], `round${m[2]}`);
      return { uri, mimeType: 'application/json', text: JSON.stringify({ flow_id: m[1], round: Number(m[2]), draft_hash: hash }) };
    },
  },
];

const prompts = {
  draft_contract: {
    description: 'Legal contract drafting prompt.',
    arguments: [
      { name: 'client_name',  required: true  },
      { name: 'jurisdiction', required: false },
      { name: 'credit_limit', required: false },
    ],
    template({ client_name, jurisdiction, credit_limit }) {
      return [{
        role: 'system',
        content:
          `You are legal counsel drafting an institutional onboarding agreement.\n\n` +
          `Client: ${client_name}` +
          (jurisdiction  ? `\nGoverning law: ${jurisdiction}`    : '') +
          (credit_limit  ? `\nCredit limit: ${credit_limit}`     : '') +
          `\n\nDraft a comprehensive onboarding agreement covering representations, credit support, termination, and governing law.`,
      }];
    },
  },
};

startMcpServer({ tools, resources, prompts, serverLabel: 'legal-server' });
