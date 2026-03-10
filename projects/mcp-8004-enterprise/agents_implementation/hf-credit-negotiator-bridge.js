/**
 * hf-credit-negotiator-bridge.js  [HF DMZ EXTERNAL — bidirectional]
 *
 * Watches CreditRiskOracle.TermsProposed events and submits counter-proposals.
 *
 * Usage:
 *   node hf-credit-negotiator-bridge.js \
 *     --credit-contract 0x... --rpc ... --privkey ... --agent-id 8
 * ENV: CREDIT_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, HF_CREDIT_AGENT_ID
 */

import { ethers } from 'ethers';
import { arg, callMcpTool } from './bridge-base.js';
import { createSigner }      from './vault-signer.js';

const LABEL        = 'hf-credit-bridge';
const MCP_ENDPOINT = arg('--mcp-endpoint', 'HF_CREDIT_MCP_ENDPOINT') ?? 'http://localhost:8021';

const RPC_URL        = arg('--rpc',           'RPC_URL')                   ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY    = arg('--privkey',        'ORACLE_PRIVATE_KEY');
const SIGNER_TYPE    = arg('--signer-type',    'SIGNER_TYPE')               ?? 'local';
const VAULT_URL      = arg('--vault-url',      'VAULT_URL');
const VAULT_ADDRESS  = arg('--vault-address',  'ORACLE_ADDRESS');
const AGENT_ID       = BigInt(arg('--agent-id','HF_CREDIT_AGENT_ID') ?? '8');

const CREDIT_CONTRACT = arg('--credit-contract', 'CREDIT_CONTRACT_ADDRESS');
if (!CREDIT_CONTRACT) { console.error(`[${LABEL}] Missing --credit-contract`); process.exit(1); }
if (!PRIVATE_KEY && SIGNER_TYPE === 'local') { console.error(`[${LABEL}] Missing --privkey`); process.exit(1); }

const ABI = [
  'event TermsProposed(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 termsHash, uint8 round, uint256 timestamp)',
  'function submitCounterProposal(bytes32 requestId, uint256 clientAgentId, bytes32 proposalHash)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = createSigner({ type: SIGNER_TYPE, privateKey: PRIVATE_KEY, vaultUrl: VAULT_URL, address: VAULT_ADDRESS }, provider);
  const oracle   = new ethers.Contract(CREDIT_CONTRACT, ABI, wallet);

  const signerAddress = await wallet.getAddress();
  console.log(`[${LABEL}] Signer        : ${signerAddress}`);
  console.log(`[${LABEL}] CreditOracle  : ${CREDIT_CONTRACT}`);
  console.log(`[${LABEL}] AgentId       : ${AGENT_ID}`);
  console.log(`[${LABEL}] MCP endpoint  : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Listening for TermsProposed events…\n`);

  oracle.on('TermsProposed', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, termsHash, round } = event.args;
    console.log(`\n[${LABEL}] ← TermsProposed  requestId=${requestId}  round=${round}`);

    try {
      const result = await callMcpTool(MCP_ENDPOINT, 'evaluate_terms', {
        flow_id: flowId, request_id: requestId,
        terms_hash: termsHash, round: Number(round),
      }, flowId);

      console.log(`[${LABEL}]   → submitCounterProposal  accepting=${result.accepting}  hash=${result.proposal_hash}`);
      const tx = await oracle.submitCounterProposal(requestId, AGENT_ID, result.proposal_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ submitCounterProposal  tx=${tx.hash}`);
    } catch (err) {
      console.error(`[${LABEL}]   ✗ ${err.message}`);
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
