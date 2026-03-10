/**
 * aml-bridge.js  [BANK DMZ EXTERNAL — bidirectional]
 *
 * Watches AMLOracle events and routes them to/from the aml-server MCP server.
 *
 * Event flows:
 *   AMLReviewRequested  → callMcpTool('screen_client')
 *     → action='request_documents' → requestClientData()
 *     → action='submit_recommendation' → submitRecommendation()
 *
 *   DataFulfilled       → callMcpTool('continue_screening')
 *     → action='request_documents' → requestClientData() (next round)
 *     → action='submit_recommendation' → submitRecommendation()
 *
 * Usage:
 *   node aml-bridge.js \
 *     --contract  0xAMLOracleAddress \
 *     --rpc       http://127.0.0.1:8545 \
 *     --privkey   0xBankAMLAgentKey \
 *     --agent-id  0
 *
 * ENV equivalents: AML_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, AML_AGENT_ID
 * Optional governance: --flow-auth, --reputation-gate, --autonomy-bounds, --action-permit, --identity-registry
 */

import { ethers } from 'ethers';
import { bootstrapBridge, callMcpTool, governancePreflight, arg } from './bridge-base.js';

const LABEL          = 'aml-bridge';
const MCP_ENDPOINT   = arg('--mcp-endpoint', 'AML_MCP_ENDPOINT') ?? 'http://localhost:8010';
const CAP_AML_REVIEW = ethers.id('aml_review');
const TOOL_SCREEN    = ethers.id('screen_client');

const ABI = [
  'event AMLReviewRequested(bytes32 indexed requestId, bytes32 indexed flowId, uint256 bankAgentId, uint256 clientAgentId, uint256 timestamp)',
  'event DataFulfilled(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 dataHash, uint256 submittingAgentId, uint256 timestamp)',
  'function requestClientData(bytes32 requestId, uint256 bankAgentId, bytes32 dataSpecHash)',
  'function submitRecommendation(bytes32 requestId, uint256 bankAgentId, bytes32 resultHash)',
];

async function handleReviewRequested(oracle, agentId, contracts, event) {
  const { requestId, flowId, clientAgentId } = event.args;
  const traceId = flowId; // flowId IS the traceId in this architecture

  console.log(`\n[${LABEL}] ← AMLReviewRequested  requestId=${requestId}  flowId=${flowId}`);

  const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_AML_REVIEW, toolHash: TOOL_SCREEN, contracts });
  if (!ok) return;

  try {
    const result = await callMcpTool(MCP_ENDPOINT, 'screen_client', {
      flow_id:         flowId,
      request_id:      requestId,
      client_agent_id: clientAgentId.toString(),
    }, traceId);

    if (result.action === 'request_documents') {
      console.log(`[${LABEL}]   → requestClientData  spec=${result.spec_hash}`);
      const tx = await oracle.requestClientData(requestId, agentId, result.spec_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ requestClientData  tx=${tx.hash}`);
    } else {
      console.log(`[${LABEL}]   → submitRecommendation  cleared=${result.cleared}`);
      const tx = await oracle.submitRecommendation(requestId, agentId, result.result_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ submitRecommendation  tx=${tx.hash}`);
    }
  } catch (err) {
    console.error(`[${LABEL}]   ✗ ${err.message}`);
  }
}

async function handleDataFulfilled(oracle, agentId, contracts, event) {
  const { requestId, flowId, dataHash, submittingAgentId } = event.args;
  const traceId = flowId;

  // Only respond to data submitted by the client agent (not our own fulfillments)
  if (submittingAgentId === agentId) return;

  console.log(`\n[${LABEL}] ← DataFulfilled  requestId=${requestId}  dataHash=${dataHash}`);

  const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_AML_REVIEW, toolHash: TOOL_SCREEN, contracts });
  if (!ok) return;

  try {
    // We need the current round; read from oracle state or pass round via event.
    // For simplicity, pass round=1 and let the server handle it.
    const result = await callMcpTool(MCP_ENDPOINT, 'continue_screening', {
      flow_id:    flowId,
      request_id: requestId,
      data_hash:  dataHash,
      round:      1,
    }, traceId);

    if (result.action === 'request_documents') {
      console.log(`[${LABEL}]   → requestClientData (round 2)  spec=${result.spec_hash}`);
      const tx = await oracle.requestClientData(requestId, agentId, result.spec_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ requestClientData  tx=${tx.hash}`);
    } else {
      console.log(`[${LABEL}]   → submitRecommendation  cleared=${result.cleared}`);
      const tx = await oracle.submitRecommendation(requestId, agentId, result.result_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ submitRecommendation  tx=${tx.hash}`);
    }
  } catch (err) {
    console.error(`[${LABEL}]   ✗ ${err.message}`);
  }
}

async function main() {
  const { wallet, contracts, agentId, CONTRACT_ADDRESS } = await bootstrapBridge(LABEL, {
    contractFlag: '--contract', contractEnv: 'AML_CONTRACT_ADDRESS',
    agentIdEnv: 'AML_AGENT_ID',
    cardGlob: f => f === 'bank-aml-agent.json',
  });

  const oracle = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`[${LABEL}] MCP endpoint : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Listening for AMLOracle events…\n`);

  oracle.on('AMLReviewRequested', (...args) => {
    const event = args[args.length - 1];
    handleReviewRequested(oracle, agentId, contracts, event);
  });

  oracle.on('DataFulfilled', (...args) => {
    const event = args[args.length - 1];
    handleDataFulfilled(oracle, agentId, contracts, event);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
