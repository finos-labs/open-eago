/**
 * legal-bridge.js  [BANK DMZ EXTERNAL — bidirectional]
 *
 * Watches LegalOracle events and routes to/from the legal-server.
 *
 * Event flows:
 *   LegalReviewRequested → issue_initial_draft → issueDraft()
 *   MarkupSubmitted      → review_markup_and_respond
 *     → issue_revised_draft → issueDraft() (next round)
 *     → submit_recommendation → submitRecommendation()
 *
 * Human approvers (approveBankSide, approveClientSide, execute, reject) are
 * external actions — this bridge only logs InHumanReview events as a prompt
 * for human intervention.
 *
 * Usage:
 *   node legal-bridge.js --contract 0x... --rpc ... --privkey ... --agent-id 0
 * ENV: LEGAL_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, LEGAL_AGENT_ID
 */

import { ethers } from 'ethers';
import { bootstrapBridge, callMcpTool, governancePreflight, arg } from './bridge-base.js';

const LABEL        = 'legal-bridge';
const MCP_ENDPOINT = arg('--mcp-endpoint', 'LEGAL_MCP_ENDPOINT') ?? 'http://localhost:8012';
const CAP_LEGAL    = ethers.id('legal_review');
const TOOL_DRAFT   = ethers.id('issue_initial_draft');

const ABI = [
  'event LegalReviewRequested(bytes32 indexed requestId, bytes32 indexed flowId, uint256 bankAgentId, uint256 clientAgentId, uint256 timestamp)',
  'event MarkupSubmitted(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 markupHash, uint8 round, uint256 agentId, uint256 timestamp)',
  'event InHumanReview(bytes32 indexed requestId, bytes32 indexed flowId, uint8 round, uint256 timestamp)',
  'function issueDraft(bytes32 requestId, uint256 bankAgentId, bytes32 contractHash)',
  'function submitRecommendation(bytes32 requestId, uint256 bankAgentId, bytes32 finalHash)',
];

async function main() {
  const { wallet, contracts, agentId, CONTRACT_ADDRESS } = await bootstrapBridge(LABEL, {
    contractFlag: '--contract', contractEnv: 'LEGAL_CONTRACT_ADDRESS',
    agentIdEnv: 'LEGAL_AGENT_ID',
    cardGlob: f => f === 'bank-legal-agent.json',
  });

  const oracle = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`[${LABEL}] MCP endpoint : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Listening for LegalOracle events…\n`);

  oracle.on('LegalReviewRequested', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, clientAgentId } = event.args;
    console.log(`\n[${LABEL}] ← LegalReviewRequested  requestId=${requestId}  flowId=${flowId}`);
    const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_LEGAL, toolHash: TOOL_DRAFT, contracts });
    if (!ok) return;
    try {
      const result = await callMcpTool(MCP_ENDPOINT, 'issue_initial_draft', {
        flow_id: flowId, request_id: requestId, client_agent_id: clientAgentId.toString(),
      }, flowId);

      console.log(`[${LABEL}]   → issueDraft  round=${result.round}  hash=${result.draft_hash}`);
      const tx = await oracle.issueDraft(requestId, agentId, result.draft_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ issueDraft  tx=${tx.hash}`);
    } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
  });

  oracle.on('MarkupSubmitted', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, markupHash, round } = event.args;
    console.log(`\n[${LABEL}] ← MarkupSubmitted  requestId=${requestId}  round=${round}`);
    const ok = await governancePreflight(LABEL, { flowId, agentId, capability: CAP_LEGAL, toolHash: TOOL_DRAFT, contracts });
    if (!ok) return;
    try {
      const result = await callMcpTool(MCP_ENDPOINT, 'review_markup_and_respond', {
        flow_id: flowId, request_id: requestId, markup_hash: markupHash, round: Number(round),
      }, flowId);

      if (result.action === 'issue_revised_draft') {
        console.log(`[${LABEL}]   → issueDraft (revised)  hash=${result.draft_hash}`);
        const tx = await oracle.issueDraft(requestId, agentId, result.draft_hash);
        await tx.wait();
        console.log(`[${LABEL}]   ✓ issueDraft  tx=${tx.hash}`);
      } else {
        console.log(`[${LABEL}]   → submitRecommendation  final=${result.final_hash}`);
        const tx = await oracle.submitRecommendation(requestId, agentId, result.final_hash);
        await tx.wait();
        console.log(`[${LABEL}]   ✓ submitRecommendation  tx=${tx.hash}`);
      }
    } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
  });

  oracle.on('InHumanReview', (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, round } = event.args;
    console.log(`\n[${LABEL}] *** InHumanReview  requestId=${requestId}  flowId=${flowId}  round=${round}`);
    console.log(`[${LABEL}] *** Human approvers: call approveBankSide() + approveClientSide() then execute()`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
