/**
 * hf-credit-negotiator-server.js
 *
 * MCP server for the HedgeFundCreditNegotiatorAgent card.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

const tools = {

  evaluate_terms: {
    description: 'Evaluate bank-proposed credit terms and produce a counter-proposal or acceptance.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string' },
        request_id: { type: 'string' },
        terms_hash: { type: 'string' },
        round:      { type: 'integer' },
        trace_id:   { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'terms_hash', 'round'],
    },
    handler({ flow_id, terms_hash, round, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[hf-credit-negotiator-server] [${trace_id ?? 'n/a'}] evaluate_terms flow=${flow_id} round=${round}`);

      // Stub: counter-propose on round 1, accept on subsequent rounds.
      if (round <= 1) {
        const proposalHash = ethers.keccak256(ethers.toUtf8Bytes(`hf-counter:${flow_id}:round${round}`));
        return { proposal_hash: proposalHash, accepting: false, notes: 'Requesting tighter spread on FX forwards.' };
      }
      // Accept as-is
      return { proposal_hash: terms_hash, accepting: true, notes: 'Terms acceptable.' };
    },
  },
};

startMcpServer({ tools, resources: [], prompts: {}, serverLabel: 'hf-credit-negotiator-server' });
