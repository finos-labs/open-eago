/**
 * hf-legal-bridge.js  [HF DMZ EXTERNAL — bidirectional]
 *
 * Watches LegalOracle.DraftIssued events and submits markup.
 *
 * Human approval (approveClientSide) is a separate external action;
 * this bridge logs InHumanReview events as a prompt for HF human intervention.
 *
 * Usage:
 *   node hf-legal-bridge.js --legal-contract 0x... --rpc ... --privkey ... --agent-id 9
 * ENV: LEGAL_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY, HF_LEGAL_AGENT_ID
 */

import { ethers } from 'ethers';
import { arg, callMcpTool } from './bridge-base.js';
import { createSigner }      from './vault-signer.js';

const LABEL        = 'hf-legal-bridge';
const MCP_ENDPOINT = arg('--mcp-endpoint', 'HF_LEGAL_MCP_ENDPOINT') ?? 'http://localhost:8022';

const RPC_URL        = arg('--rpc',           'RPC_URL')                ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY    = arg('--privkey',        'ORACLE_PRIVATE_KEY');
const SIGNER_TYPE    = arg('--signer-type',    'SIGNER_TYPE')            ?? 'local';
const VAULT_URL      = arg('--vault-url',      'VAULT_URL');
const VAULT_ADDRESS  = arg('--vault-address',  'ORACLE_ADDRESS');
const AGENT_ID       = BigInt(arg('--agent-id','HF_LEGAL_AGENT_ID') ?? '9');

const LEGAL_CONTRACT = arg('--legal-contract', 'LEGAL_CONTRACT_ADDRESS');
if (!LEGAL_CONTRACT) { console.error(`[${LABEL}] Missing --legal-contract`); process.exit(1); }
if (!PRIVATE_KEY && SIGNER_TYPE === 'local') { console.error(`[${LABEL}] Missing --privkey`); process.exit(1); }

const ABI = [
  'event DraftIssued(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 contractHash, uint8 round, uint256 timestamp)',
  'event InHumanReview(bytes32 indexed requestId, bytes32 indexed flowId, uint8 round, uint256 timestamp)',
  'function submitMarkup(bytes32 requestId, uint256 clientAgentId, bytes32 markupHash)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = createSigner({ type: SIGNER_TYPE, privateKey: PRIVATE_KEY, vaultUrl: VAULT_URL, address: VAULT_ADDRESS }, provider);
  const oracle   = new ethers.Contract(LEGAL_CONTRACT, ABI, wallet);

  const signerAddress = await wallet.getAddress();
  console.log(`[${LABEL}] Signer        : ${signerAddress}`);
  console.log(`[${LABEL}] LegalOracle   : ${LEGAL_CONTRACT}`);
  console.log(`[${LABEL}] AgentId       : ${AGENT_ID}`);
  console.log(`[${LABEL}] MCP endpoint  : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Listening for DraftIssued / InHumanReview events…\n`);

  oracle.on('DraftIssued', async (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, contractHash, round } = event.args;
    console.log(`\n[${LABEL}] ← DraftIssued  requestId=${requestId}  round=${round}`);

    try {
      const result = await callMcpTool(MCP_ENDPOINT, 'review_draft', {
        flow_id:    flowId,
        request_id: requestId,
        draft_hash: contractHash,
        round:      Number(round),
      }, flowId);

      console.log(`[${LABEL}]   → submitMarkup  changes=${result.changes}  hash=${result.markup_hash}`);
      const tx = await oracle.submitMarkup(requestId, AGENT_ID, result.markup_hash);
      await tx.wait();
      console.log(`[${LABEL}]   ✓ submitMarkup  tx=${tx.hash}`);
    } catch (err) {
      console.error(`[${LABEL}]   ✗ ${err.message}`);
    }
  });

  oracle.on('InHumanReview', (...args) => {
    const event = args[args.length - 1];
    const { requestId, flowId, round } = event.args;
    console.log(`\n[${LABEL}] *** InHumanReview  requestId=${requestId}  flowId=${flowId}  round=${round}`);
    console.log(`[${LABEL}] *** HF human approver: call approveClientSide(requestId, ${AGENT_ID})`);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
