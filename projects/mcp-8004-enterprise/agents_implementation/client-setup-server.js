/**
 * client-setup-server.js
 *
 * Shared MCP server for all three bank setup agent cards:
 *   bank-legal-entity-setup-agent.json  (port 8014)
 *   bank-account-setup-agent.json       (port 8015)
 *   bank-product-setup-agent.json       (port 8016)
 *
 * The capability field in the agent card determines which tool the bridge
 * will invoke. All three tools are available on every instance.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

function stubHash(prefix, flowId) {
  return ethers.keccak256(ethers.toUtf8Bytes(`${prefix}:${flowId}`));
}

const tools = {

  setup_legal_entity: {
    description: 'Register the client legal entity in bank internal systems.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:  { type: 'string' },
        trace_id: { type: 'string' },
      },
      required: ['flow_id'],
    },
    handler({ flow_id, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[client-setup-server] [${trace_id ?? 'n/a'}] setup_legal_entity flow=${flow_id}`);
      return {
        entity_spec_hash: stubHash('entity-spec', flow_id),
        entity_ref:       `ENTITY-${flow_id.slice(2, 10).toUpperCase()}`,
      };
    },
  },

  setup_account: {
    description: 'Provision trading accounts for the onboarded client.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:  { type: 'string' },
        trace_id: { type: 'string' },
      },
      required: ['flow_id'],
    },
    handler({ flow_id, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[client-setup-server] [${trace_id ?? 'n/a'}] setup_account flow=${flow_id}`);
      return {
        account_spec_hash: stubHash('account-spec', flow_id),
        account_ref:       `ACCT-${flow_id.slice(2, 10).toUpperCase()}`,
      };
    },
  },

  setup_products: {
    description: 'Configure approved financial products for the client.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:  { type: 'string' },
        trace_id: { type: 'string' },
      },
      required: ['flow_id'],
    },
    handler({ flow_id, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[client-setup-server] [${trace_id ?? 'n/a'}] setup_products flow=${flow_id}`);
      return {
        product_spec_hash: stubHash('product-spec', flow_id),
        products:          ['FX_SPOT', 'FX_FORWARD', 'RATES_IRS'],
      };
    },
  },
};

startMcpServer({ tools, resources: [], prompts: {}, serverLabel: 'client-setup-server' });
