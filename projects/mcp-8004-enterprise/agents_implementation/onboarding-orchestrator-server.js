/**
 * onboarding-orchestrator-server.js
 *
 * MCP server for the BankOnboardingOrchestrator card.
 * The initiate_onboarding tool is a planning tool only — the actual on-chain
 * transactions are submitted by the orchestrator bridge, which watches for
 * the MCP response and translates it into contract calls.
 */

import { startMcpServer } from './mcp-server-base.js';

const tools = {

  initiate_onboarding: {
    description: 'Plan an institutional client onboarding flow initiation.',
    inputSchema: {
      type: 'object',
      properties: {
        flow_id:              { type: 'string' },
        client_address:       { type: 'string' },
        bank_aml_agent_id:    { type: 'string' },
        bank_credit_agent_id: { type: 'string' },
        bank_legal_agent_id:  { type: 'string' },
        hf_doc_agent_id:      { type: 'string' },
        hf_credit_agent_id:   { type: 'string' },
        hf_legal_agent_id:    { type: 'string' },
        trace_id:             { type: 'string' },
      },
      required: ['flow_id', 'client_address', 'bank_aml_agent_id', 'bank_credit_agent_id',
                 'bank_legal_agent_id', 'hf_doc_agent_id', 'hf_credit_agent_id', 'hf_legal_agent_id'],
    },
    handler(params) {
      const { flow_id, trace_id, ...rest } = params;
      if (!flow_id) throw new Error('flow_id required');
      console.log(`[orchestrator-server] [${trace_id ?? 'n/a'}] initiate_onboarding flow=${flow_id}`);

      // Return the plan; the bridge submits it on-chain
      return {
        flow_id,
        status:  'ready_to_initiate',
        agents:  {
          bank_aml_agent_id:    rest.bank_aml_agent_id,
          bank_credit_agent_id: rest.bank_credit_agent_id,
          bank_legal_agent_id:  rest.bank_legal_agent_id,
          hf_doc_agent_id:      rest.hf_doc_agent_id,
          hf_credit_agent_id:   rest.hf_credit_agent_id,
          hf_legal_agent_id:    rest.hf_legal_agent_id,
        },
      };
    },
  },
};

startMcpServer({ tools, resources: [], prompts: {}, serverLabel: 'onboarding-orchestrator-server' });
