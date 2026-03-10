/**
 * onboarding-orchestrator-bridge.js  [BANK DMZ INTERNAL — submit-only]
 *
 * HTTP trigger endpoint for initiating onboarding flows.
 * Receives a POST /initiate with agent IDs, calls the orchestrator MCP server
 * to plan the flow, then submits on-chain:
 *   1. OnboardingRegistry.initiateOnboarding(flowId, clientAddress)
 *   2. AMLOracle.requestAMLReview(flowId, bankAmlAgentId, hfDocAgentId)
 *   3. CreditRiskOracle.requestCreditReview(flowId, bankCreditAgentId, hfCreditAgentId)
 *   4. LegalOracle.requestLegalReview(flowId, bankLegalAgentId, hfLegalAgentId)
 *
 * REST trigger:
 *   POST http://localhost:9000/initiate
 *   { "flowId": "0x...", "clientAddress": "0x...", "bankAmlAgentId": "0", ... }
 *
 * Usage:
 *   node onboarding-orchestrator-bridge.js \
 *     --onboarding-registry 0x... \
 *     --aml-contract        0x... \
 *     --credit-contract     0x... \
 *     --legal-contract      0x... \
 *     --rpc http://127.0.0.1:8545 --privkey 0x...
 *
 * ENV: ONBOARDING_REGISTRY_ADDRESS, AML_CONTRACT_ADDRESS, CREDIT_CONTRACT_ADDRESS,
 *      LEGAL_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY
 */

import http   from 'node:http';
import { ethers } from 'ethers';
import { arg, callMcpTool } from './bridge-base.js';
import { createSigner }      from './vault-signer.js';

const LABEL = 'orchestrator-bridge';

const RPC_URL         = arg('--rpc',                  'RPC_URL')                   ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY     = arg('--privkey',              'ORACLE_PRIVATE_KEY');
const SIGNER_TYPE     = arg('--signer-type',          'SIGNER_TYPE')               ?? 'local';
const VAULT_URL       = arg('--vault-url',            'VAULT_URL');
const VAULT_ADDRESS   = arg('--vault-address',        'ORACLE_ADDRESS');
const TRIGGER_PORT    = parseInt(arg('--trigger-port','ORCHESTRATOR_PORT') ?? '9000', 10);
const MCP_ENDPOINT    = arg('--mcp-endpoint',         'ORCHESTRATOR_MCP_ENDPOINT') ?? 'http://localhost:8013';

const ONBOARDING_REG  = arg('--onboarding-registry',  'ONBOARDING_REGISTRY_ADDRESS');
const AML_CONTRACT    = arg('--aml-contract',          'AML_CONTRACT_ADDRESS');
const CREDIT_CONTRACT = arg('--credit-contract',       'CREDIT_CONTRACT_ADDRESS');
const LEGAL_CONTRACT  = arg('--legal-contract',        'LEGAL_CONTRACT_ADDRESS');

if (!ONBOARDING_REG)  { console.error(`[${LABEL}] Missing --onboarding-registry`); process.exit(1); }
if (!AML_CONTRACT)    { console.error(`[${LABEL}] Missing --aml-contract`);         process.exit(1); }
if (!CREDIT_CONTRACT) { console.error(`[${LABEL}] Missing --credit-contract`);      process.exit(1); }
if (!LEGAL_CONTRACT)  { console.error(`[${LABEL}] Missing --legal-contract`);       process.exit(1); }
if (!PRIVATE_KEY && SIGNER_TYPE === 'local') { console.error(`[${LABEL}] Missing --privkey`); process.exit(1); }

const ONBOARDING_ABI = [
  'function initiateOnboarding(bytes32 flowId, address initiator)',
];
const AML_ABI = [
  'function requestAMLReview(bytes32 flowId, uint256 bankAgentId, uint256 clientAgentId) returns (bytes32)',
];
const CREDIT_ABI = [
  'function requestCreditReview(bytes32 flowId, uint256 bankAgentId, uint256 clientAgentId) returns (bytes32)',
];
const LEGAL_ABI = [
  'function requestLegalReview(bytes32 flowId, uint256 bankAgentId, uint256 clientAgentId) returns (bytes32)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = createSigner({ type: SIGNER_TYPE, privateKey: PRIVATE_KEY, vaultUrl: VAULT_URL, address: VAULT_ADDRESS }, provider);

  const onboardingReg  = new ethers.Contract(ONBOARDING_REG,  ONBOARDING_ABI, wallet);
  const amlOracle      = new ethers.Contract(AML_CONTRACT,    AML_ABI,        wallet);
  const creditOracle   = new ethers.Contract(CREDIT_CONTRACT, CREDIT_ABI,     wallet);
  const legalOracle    = new ethers.Contract(LEGAL_CONTRACT,  LEGAL_ABI,      wallet);

  const signerAddress = await wallet.getAddress();
  console.log(`[${LABEL}] Signer               : ${signerAddress}`);
  console.log(`[${LABEL}] OnboardingRegistry   : ${ONBOARDING_REG}`);
  console.log(`[${LABEL}] AMLOracle            : ${AML_CONTRACT}`);
  console.log(`[${LABEL}] CreditRiskOracle     : ${CREDIT_CONTRACT}`);
  console.log(`[${LABEL}] LegalOracle          : ${LEGAL_CONTRACT}`);
  console.log(`[${LABEL}] MCP endpoint         : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] Trigger REST port    : ${TRIGGER_PORT}`);

  async function initiateFlow(params) {
    const {
      flowId, clientAddress,
      bankAmlAgentId, bankCreditAgentId, bankLegalAgentId,
      hfDocAgentId, hfCreditAgentId, hfLegalAgentId,
    } = params;

    if (!flowId || !clientAddress) throw new Error('flowId and clientAddress required');

    // Call orchestrator MCP server for planning/logging
    const plan = await callMcpTool(MCP_ENDPOINT, 'initiate_onboarding', {
      flow_id:              flowId,
      client_address:       clientAddress,
      bank_aml_agent_id:    bankAmlAgentId,
      bank_credit_agent_id: bankCreditAgentId,
      bank_legal_agent_id:  bankLegalAgentId,
      hf_doc_agent_id:      hfDocAgentId,
      hf_credit_agent_id:   hfCreditAgentId,
      hf_legal_agent_id:    hfLegalAgentId,
    }, flowId).catch(() => ({ status: 'mcp_unavailable' }));

    console.log(`[${LABEL}] Plan: ${JSON.stringify(plan)}`);

    // 1. Initiate onboarding registry flow
    console.log(`[${LABEL}] → initiateOnboarding flowId=${flowId}`);
    const tx0 = await onboardingReg.initiateOnboarding(flowId, clientAddress);
    await tx0.wait();
    console.log(`[${LABEL}] ✓ initiateOnboarding tx=${tx0.hash}`);

    // 2–4. Open all three review requests in parallel
    console.log(`[${LABEL}] → opening AML / Credit / Legal review requests…`);
    const [amlReqId, creditReqId, legalReqId] = await Promise.all([
      amlOracle.requestAMLReview(flowId,    BigInt(bankAmlAgentId),    BigInt(hfDocAgentId)),
      creditOracle.requestCreditReview(flowId, BigInt(bankCreditAgentId), BigInt(hfCreditAgentId)),
      legalOracle.requestLegalReview(flowId,   BigInt(bankLegalAgentId),  BigInt(hfLegalAgentId)),
    ]);

    await Promise.all([amlReqId.wait(), creditReqId.wait(), legalReqId.wait()]);
    console.log(`[${LABEL}] ✓ all review requests opened for flowId=${flowId}`);

    return { flow_id: flowId, status: 'initiated' };
  }

  // ── REST trigger server ──────────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/initiate') {
      res.writeHead(404); res.end(JSON.stringify({ error: 'POST /initiate only' }));
      return;
    }
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'invalid JSON' })); return;
      }
      try {
        const result = await initiateFlow(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[${LABEL}] ✗ ${err.message}`);
        res.writeHead(500); res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  server.listen(TRIGGER_PORT, () =>
    console.log(`[${LABEL}] REST trigger → http://localhost:${TRIGGER_PORT}/initiate`)
  );
}

main().catch(err => { console.error(err); process.exit(1); });
