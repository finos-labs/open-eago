/**
 * credit-risk-bridge.js  [BANK DMZ EXTERNAL — bidirectional]
 *
 * Watches CreditRiskOracle events and routes to/from the credit-risk-server.
 *
 * Event flows:
 *   CreditReviewRequested → assess_credit
 *     → request_documents → requestClientData()
 *     → propose_terms     → proposeTerms()
 *     → submit_recommendation → submitRecommendation()
 *
 *   DataFulfilled   → continue_assessment(trigger='data_fulfilled')
 *     → same actions as above
 *
 *   CounterProposed → continue_assessment(trigger='counter_proposed')
 *     → propose_terms  → proposeTerms() (new round)
 *     → accept_terms   → acceptTerms() then submitRecommendation()
 *
 * Usage:
 *   node credit-risk-bridge.js --contract 0x... --rpc ... --privkey ... --agent-id 0
 * ENV: CREDIT_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, CREDIT_AGENT_ID
 */

import { ethers } from 'ethers';
import { bootstrapBridge, callMcpTool, governancePreflight, arg } from './bridge-base.js';

const LABEL            = 'credit-risk-bridge';
const MCP_ENDPOINT     = arg('--mcp-endpoint', 'CREDIT_MCP_ENDPOINT') ?? 'http://localhost:8011';
const CAP_CREDIT       = ethers.id('credit_review');
const TOOL_ASSESS      = ethers.id('assess_credit');

const ABI = [
  'event CreditReviewRequested(bytes32 indexed requestId, bytes32 indexed flowId, uint256 bankAgentId, uint256 clientAgentId, uint256 timestamp)',
  'event DataFulfilled(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 dataHash, uint256 submittingAgentId, uint256 timestamp)',
  'event CounterProposed(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 proposalHash, uint256 agentId, uint256 timestamp)',
  'function requestClientData(bytes32 requestId, uint256 bankAgentId, bytes32 dataSpecHash)',
  'function proposeTerms(bytes32 requestId, uint256 bankAgentId, bytes32 termsHash)',
  'function acceptTerms(bytes32 requestId, uint256 bankAgentId, bytes32 agreedTermsHash)',
  'function submitRecommendation(bytes32 requestId, uint256 bankAgentId, bytes32 resultHash)',
  'function getRequest(bytes32 requestId) view returns (tuple(bytes32 flowId, uint256 clientAgentId, uint256 bankAgentId, uint8 status, bytes32 dataRequestSpec, uint8 dataRequestRound, bytes32 currentTermsHash, uint8 negotiationRound, bytes32 resultHash, uint256 createdAt))',
];

async function dispatchAction(oracle, agentId, requestId, result, traceId) {
  if (result.action === 'request_documents') {
    console.log(`[${LABEL}]   → requestClientData  spec=${result.spec_hash}`);
    const tx = await oracle.requestClientData(requestId, agentId, result.spec_hash);
    await tx.wait();
    console.log(`[${LABEL}]   ✓ requestClientData  tx=${tx.hash}`);
  } else if (result.action === 'propose_terms') {
    console.log(`[${LABEL}]   → proposeTerms  hash=${result.terms_hash}`);
    const tx = await oracle.proposeTerms(requestId, agentId, result.terms_hash);
    await tx.wait();
    console.log(`[${LABEL}]   ✓ proposeTerms  tx=${tx.hash}`);
  } else if (result.action === 'accept_terms') {
    console.log(`[${LABEL}]   → acceptTerms  agreed=${result.agreed_hash}`);
    const tx1 = await oracle.acceptTerms(requestId, agentId, result.agreed_hash);
    await tx1.wait();
    console.log(`[${LABEL}]   ✓ acceptTerms  tx=${tx1.hash}`);
    // After accepting, submit recommendation
    const req = await oracle.getRequest(requestId);
    const resultHash = ethers.keccak256(ethers.toUtf8Bytes(`credit-result:${req.flowId}`));
    const tx2 = await oracle.submitRecommendation(requestId, agentId, resultHash);
    await tx2.wait();
    console.log(`[${LABEL}]   ✓ submitRecommendation  tx=${tx2.hash}`);
  } else if (result.action === 'submit_recommendation') {
    console.log(`[${LABEL}]   → submitRecommendation  approved=${result.approved}`);
    const tx = await oracle.submitRecommendation(requestId, agentId, result.result_hash);
    await tx.wait();
    console.log(`[${LABEL}]   ✓ submitRecommendation  tx=${tx.hash}`);
  }
}

async function main() {
  const { wallet, contracts, agentId, CONTRACT_ADDRESS } = await bootstrapBridge(LABEL, {
    contractFlag: '--contract', contractEnv: 'CREDIT_CONTRACT_ADDRESS',
    agentIdEnv: 'CREDIT_AGENT_ID',
    cardGlob: f => f === 'bank-credit-risk-agent.json',
  });

  const oracle = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`[${LABEL}] MCP endpoint : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Listening for CreditRiskOracle events…\n`);

  oracle.on('CreditReviewRequested', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, clientAgentId } = event.args;
    console.log(`\n[${LABEL}] ← CreditReviewRequested  requestId=${requestId}  flowId=${flowId}`);
    const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_CREDIT, toolHash: TOOL_ASSESS, contracts });
    if (!ok) return;
    try {
      const result = await callMcpTool(MCP_ENDPOINT, 'assess_credit', {
        flow_id: flowId, request_id: requestId, client_agent_id: clientAgentId.toString(),
      }, flowId);
      await dispatchAction(oracle, agentId, requestId, result, flowId);
    } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
  });

  oracle.on('DataFulfilled', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, dataHash, submittingAgentId } = event.args;
    if (submittingAgentId === agentId) return; // our own tx
    console.log(`\n[${LABEL}] ← DataFulfilled  requestId=${requestId}`);
    const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_CREDIT, toolHash: TOOL_ASSESS, contracts });
    if (!ok) return;
    try {
      const req    = await oracle.getRequest(requestId);
      const result = await callMcpTool(MCP_ENDPOINT, 'continue_assessment', {
        flow_id: flowId, request_id: requestId,
        trigger: 'data_fulfilled', data_hash: dataHash,
        current_round: Number(req.negotiationRound),
      }, flowId);
      await dispatchAction(oracle, agentId, requestId, result, flowId);
    } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
  });

  oracle.on('CounterProposed', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, proposalHash } = event.args;
    console.log(`\n[${LABEL}] ← CounterProposed  requestId=${requestId}  proposal=${proposalHash}`);
    const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_CREDIT, toolHash: TOOL_ASSESS, contracts });
    if (!ok) return;
    try {
      const req    = await oracle.getRequest(requestId);
      const result = await callMcpTool(MCP_ENDPOINT, 'continue_assessment', {
        flow_id: flowId, request_id: requestId,
        trigger: 'counter_proposed', data_hash: proposalHash,
        current_round: Number(req.negotiationRound),
      }, flowId);
      await dispatchAction(oracle, agentId, requestId, result, flowId);
    } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
