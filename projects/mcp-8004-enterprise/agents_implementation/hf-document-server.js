/**
 * hf-document-server.js
 *
 * MCP server for the HedgeFundDocumentAgent card.
 * Implements tools from agents/mcp/hf-document.mcp.json.
 */

import { ethers }        from 'ethers';
import { startMcpServer } from './mcp-server-base.js';

const tools = {

  assemble_documents: {
    description: 'Assemble client documents in response to a bank data request.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:     { type: 'string' },
        request_id:  { type: 'string' },
        oracle_type: { type: 'string', enum: ['aml', 'credit'] },
        spec_hash:   { type: 'string' },
        round:       { type: 'integer' },
        trace_id:    { type: 'string' },
      },
      required: ['flow_id', 'request_id', 'oracle_type', 'spec_hash'],
    },
    handler({ flow_id, oracle_type, spec_hash, round, trace_id }) {
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[hf-document-server] [${trace_id ?? 'n/a'}] assemble_documents flow=${flow_id} oracle=${oracle_type} round=${round ?? 1}`);

      const docTypes = oracle_type === 'aml'
        ? ['passport_copies', 'corporate_registry', 'beneficial_ownership', 'source_of_funds']
        : ['audited_financials', 'nav_statements', 'credit_references', 'prime_broker_letter'];

      const dataHash = ethers.keccak256(ethers.toUtf8Bytes(`hf-docs:${flow_id}:${oracle_type}:${spec_hash}:round${round ?? 1}`));
      return { data_hash: dataHash, documents: docTypes };
    },
  },
};

startMcpServer({ tools, resources: [], prompts: {}, serverLabel: 'hf-document-server' });
