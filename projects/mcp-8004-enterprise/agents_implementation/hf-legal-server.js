/**
 * hf-legal-server.js
 *
 * MCP server for the HedgeFundLegalAgent card.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

const tools = {

  review_draft: {
    description: 'Review a bank contract draft and produce markup.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:    { type: 'string' },
        request_id: { type: 'string' },
        draft_hash: { type: 'string' },
        round:      { type: 'integer' },
        trace_id:   { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'draft_hash', 'round'],
    },
    handler({ flow_id, draft_hash, round, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[hf-legal-server] [${trace_id ?? 'n/a'}] review_draft flow=${flow_id} round=${round}`);

      const markupHash = ethers.keccak256(ethers.toUtf8Bytes(`hf-markup:${flow_id}:round${round}:${draft_hash}`));
      return {
        markup_hash: markupHash,
        changes:     round <= 1 ? 3 : 0,
        notes:       round <= 1 ? 'Proposed amendments to indemnity clause and dispute resolution.' : 'No further changes.',
      };
    },
  },
};

startMcpServer({ tools, resources: [], prompts: {}, serverLabel: 'hf-legal-server' });
