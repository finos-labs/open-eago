/**
 * credit-risk-server.js
 *
 * MCP server for the BankCreditRiskAgent card.
 * Implements tools from agents/mcp/credit-risk.mcp.json.
 *
 * Stub: assess_credit proposes terms on first call;
 *       continue_assessment accepts terms after one counter-proposal.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

function stubHash(prefix, flowId, suffix) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${prefix}:${flowId}:${suffix}`));
}

// Track negotiation state per flow (in-memory; for demo purposes)
const negotiationState = new Map(); // flowId → { round, lastTermsHash }

const tools = {

  assess_credit: {
    description: 'Initiate credit risk assessment for a new onboarding client.',
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
      console.log(`[credit-risk-server] [${trace_id ?? 'n/a'}] assess_credit flow=${flow_id}`);

      // Stub: propose terms immediately
      const termsHash = stubHash('credit-terms', flow_id, 'v1');
      negotiationState.set(flow_id, { round: 1, lastTermsHash: termsHash });
      return { action: 'propose_terms', terms_hash: termsHash };
    },
  },

  continue_assessment: {
    description: 'Resume credit assessment after documents or a counter-proposal.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:       { type: 'string' },
        request_id:    { type: 'string' },
        trigger:       { type: 'string', enum: ['data_fulfilled', 'counter_proposed'] },
        data_hash:     { type: 'string' },
        current_round: { type: 'integer' },
        trace_id:      { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'trigger', 'data_hash'],
    },
    handler({ flow_id, trigger, data_hash, current_round, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[credit-risk-server] [${trace_id ?? 'n/a'}] continue_assessment flow=${flow_id} trigger=${trigger}`);

      const state = negotiationState.get(flow_id) ?? { round: 0 };

      if (trigger === 'counter_proposed') {
        // Accept the counter-proposal (stub: always accept after first counter)
        const agreedHash = stubHash('credit-agreed', flow_id, `round${state.round}`);
        return { action: 'accept_terms', agreed_hash: agreedHash };
      }

      // data_fulfilled: assess and submit recommendation
      return {
        action:      'submit_recommendation',
        result_hash: stubHash('credit-result', flow_id, 'final'),
        approved:    true,
      };
    },
  },
};

const resources = [
  {
    uri: 'credit://{flow_id}/terms', name: 'Credit Terms',
    description: 'Current proposed credit terms.', mimeType: 'application/json',
    _resolve(uri) {
      const m = uri.match(/^credit:\/\/(.+)\/terms$/);
      if (!m) return null;
      const state = negotiationState.get(m[1]);
      return { uri, mimeType: 'application/json', text: JSON.stringify(state ?? {}) };
    },
  },
];

const prompts = {
  credit_assessment: {
    description: 'Credit risk assessment prompt.',
    arguments: [
      { name: 'client_name', required: true },
      { name: 'aum',         required: false },
    ],
    template({ client_name, aum }) {
      return [{
        role: 'system',
        content:
          `You are a credit risk officer assessing an institutional client.\n\n` +
          `Client: ${client_name}${aum ? `\nAUM: ${aum}` : ''}\n\n` +
          `Propose credit limit, margin requirements, and approved products.`,
      }];
    },
  },
};

startMcpServer({ tools, resources, prompts, serverLabel: 'credit-risk-server' });
