/**
 * hf-document-bridge.js  [HF DMZ EXTERNAL — bidirectional]
 *
 * Watches DataRequested events from both AMLOracle and CreditRiskOracle,
 * calls the HedgeFundDocumentAgent MCP server, and submits fulfillDataRequest()
 * to the appropriate oracle.
 *
 * Usage:
 *   node hf-document-bridge.js \
 *     --aml-contract    0x... \
 *     --credit-contract 0x... \
 *     --rpc http://127.0.0.1:8545 \
 *     --privkey 0x... \
 *     --agent-id 7
 *
 * ENV: AML_CONTRACT_ADDRESS, CREDIT_CONTRACT_ADDRESS, RPC_URL,
 *      ORACLE_PRIVATE_KEY, HF_DOC_AGENT_ID
 */

import { ethers } from 'ethers';
import { arg, callMcpTool } from './bridge-base.js';
import { createSigner }      from './vault-signer.js';

const LABEL        = 'hf-document-bridge';
const MCP_ENDPOINT = arg('--mcp-endpoint', 'HF_DOC_MCP_ENDPOINT') ?? 'http://localhost:8020';

const RPC_URL        = arg('--rpc',           'RPC_URL')               ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY    = arg('--privkey',        'ORACLE_PRIVATE_KEY');
const SIGNER_TYPE    = arg('--signer-type',    'SIGNER_TYPE')           ?? 'local';
const VAULT_URL      = arg('--vault-url',      'VAULT_URL');
const VAULT_ADDRESS  = arg('--vault-address',  'ORACLE_ADDRESS');
const AGENT_ID       = BigInt(arg('--agent-id','HF_DOC_AGENT_ID') ?? '7');

const AML_CONTRACT    = arg('--aml-contract',    'AML_CONTRACT_ADDRESS');
const CREDIT_CONTRACT = arg('--credit-contract', 'CREDIT_CONTRACT_ADDRESS');

if (!AML_CONTRACT)    { console.error(`[${LABEL}] Missing --aml-contract`);    process.exit(1); }
if (!CREDIT_CONTRACT) { console.error(`[${LABEL}] Missing --credit-contract`); process.exit(1); }
if (!PRIVATE_KEY && SIGNER_TYPE === 'local') { console.error(`[${LABEL}] Missing --privkey`); process.exit(1); }

const DATA_REQUESTED_ABI = [
  'event DataRequested(bytes32 indexed requestId, bytes32 indexed flowId, bytes32 dataSpecHash, uint8 round, uint256 timestamp)',
  'function fulfillDataRequest(bytes32 requestId, uint256 clientAgentId, bytes32 dataHash)',
];

async function handleDataRequested(oracle, oracleType, event) {
  const { requestId, flowId, dataSpecHash, round } = event.args;
  console.log(`\n[${LABEL}] ← DataRequested [${oracleType}]  requestId=${requestId}  round=${round}`);

  try {
    const result = await callMcpTool(MCP_ENDPOINT, 'assemble_documents', {
      flow_id:     flowId,
      request_id:  requestId,
      oracle_type: oracleType,
      spec_hash:   dataSpecHash,
      round:       Number(round),
    }, flowId);

    console.log(`[${LABEL}]   → fulfillDataRequest  dataHash=${result.data_hash}  docs=${result.documents?.join(',')}`);
    const tx = await oracle.fulfillDataRequest(requestId, AGENT_ID, result.data_hash);
    await tx.wait();
    console.log(`[${LABEL}]   ✓ fulfillDataRequest  tx=${tx.hash}`);
  } catch (err) {
    console.error(`[${LABEL}]   ✗ ${err.message}`);
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = createSigner({ type: SIGNER_TYPE, privateKey: PRIVATE_KEY, vaultUrl: VAULT_URL, address: VAULT_ADDRESS }, provider);

  const amlOracle    = new ethers.Contract(AML_CONTRACT,    DATA_REQUESTED_ABI, wallet);
  const creditOracle = new ethers.Contract(CREDIT_CONTRACT, DATA_REQUESTED_ABI, wallet);

  const signerAddress = await wallet.getAddress();
  console.log(`[${LABEL}] Signer        : ${signerAddress}`);
  console.log(`[${LABEL}] AMLOracle     : ${AML_CONTRACT}`);
  console.log(`[${LABEL}] CreditOracle  : ${CREDIT_CONTRACT}`);
  console.log(`[${LABEL}] AgentId       : ${AGENT_ID}`);
  console.log(`[${LABEL}] MCP endpoint  : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Listening for DataRequested events…\n`);

  amlOracle.on('DataRequested', (...args) => {
    handleDataRequested(amlOracle, 'aml', args[args.length - 1]);
  });
  creditOracle.on('DataRequested', (...args) => {
    handleDataRequested(creditOracle, 'credit', args[args.length - 1]);
  });
}

main().catch(err => { console.error(err); process.exit(1); });
