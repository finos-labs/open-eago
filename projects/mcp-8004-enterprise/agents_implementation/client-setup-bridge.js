/**
 * client-setup-bridge.js  [BANK DMZ INTERNAL — submit-only]
 *
 * Watches OnboardingRegistry.PhaseCompleted events and drives the three
 * sequential client setup phases.
 *
 *   ALL_REVIEWS_DONE set  → setup_legal_entity → ClientSetupOracle.setupLegalEntity()
 *   ENTITY_SETUP_DONE set → setup_account      → ClientSetupOracle.setupAccount()
 *   ACCOUNT_SETUP_DONE set→ setup_products     → ClientSetupOracle.setupProducts()
 *
 * Each setup agent has its own NFT id; all share the same MCP server script.
 *
 * Usage:
 *   node client-setup-bridge.js \
 *     --onboarding-registry  0x... \
 *     --setup-contract       0x... \
 *     --rpc http://127.0.0.1:8545 \
 *     --privkey 0x... \
 *     --entity-agent-id  4 \
 *     --account-agent-id 5 \
 *     --product-agent-id 6
 *
 * ENV: ONBOARDING_REGISTRY_ADDRESS, SETUP_CONTRACT_ADDRESS, RPC_URL, ORACLE_PRIVATE_KEY,
 *      ENTITY_AGENT_ID, ACCOUNT_AGENT_ID, PRODUCT_AGENT_ID
 */

import { ethers } from 'ethers';
import { arg, callMcpTool } from './bridge-base.js';
import { createSigner }      from './vault-signer.js';

const LABEL = 'setup-bridge';

const RPC_URL          = arg('--rpc',                  'RPC_URL')                   ?? 'http://127.0.0.1:8545';
const PRIVATE_KEY      = arg('--privkey',              'ORACLE_PRIVATE_KEY');
const SIGNER_TYPE      = arg('--signer-type',          'SIGNER_TYPE')               ?? 'local';
const VAULT_URL        = arg('--vault-url',            'VAULT_URL');
const VAULT_ADDRESS    = arg('--vault-address',        'ORACLE_ADDRESS');
const MCP_ENDPOINT     = arg('--mcp-endpoint',         'SETUP_MCP_ENDPOINT')        ?? 'http://localhost:8014';

const ONBOARDING_REG   = arg('--onboarding-registry',  'ONBOARDING_REGISTRY_ADDRESS');
const SETUP_CONTRACT   = arg('--setup-contract',        'SETUP_CONTRACT_ADDRESS');
const ENTITY_AGENT_ID  = BigInt(arg('--entity-agent-id', 'ENTITY_AGENT_ID')  ?? '4');
const ACCOUNT_AGENT_ID = BigInt(arg('--account-agent-id','ACCOUNT_AGENT_ID') ?? '5');
const PRODUCT_AGENT_ID = BigInt(arg('--product-agent-id','PRODUCT_AGENT_ID') ?? '6');

if (!ONBOARDING_REG)  { console.error(`[${LABEL}] Missing --onboarding-registry`); process.exit(1); }
if (!SETUP_CONTRACT)  { console.error(`[${LABEL}] Missing --setup-contract`);       process.exit(1); }
if (!PRIVATE_KEY && SIGNER_TYPE === 'local') { console.error(`[${LABEL}] Missing --privkey`); process.exit(1); }

const REGISTRY_ABI = [
  'event PhaseCompleted(bytes32 indexed flowId, uint8 indexed phase, uint256 timestamp)',
  'function phaseBitmask(bytes32 flowId) view returns (uint8)',
  'function ALL_REVIEWS_DONE() view returns (uint8)',
  'function PHASE_ENTITY_SETUP_DONE() view returns (uint8)',
  'function PHASE_ACCOUNT_SETUP_DONE() view returns (uint8)',
];

const SETUP_ABI = [
  'function setupLegalEntity(bytes32 flowId, uint256 agentId, bytes32 entitySpecHash)',
  'function setupAccount(bytes32 flowId, uint256 agentId, bytes32 accountSpecHash)',
  'function setupProducts(bytes32 flowId, uint256 agentId, bytes32 productSpecHash)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = createSigner({ type: SIGNER_TYPE, privateKey: PRIVATE_KEY, vaultUrl: VAULT_URL, address: VAULT_ADDRESS }, provider);

  const registry     = new ethers.Contract(ONBOARDING_REG, REGISTRY_ABI, wallet);
  const setupOracle  = new ethers.Contract(SETUP_CONTRACT,  SETUP_ABI,    wallet);

  const ALL_REVIEWS_DONE    = await registry.ALL_REVIEWS_DONE();
  const ENTITY_SETUP_DONE   = await registry.PHASE_ENTITY_SETUP_DONE();
  const ACCOUNT_SETUP_DONE  = await registry.PHASE_ACCOUNT_SETUP_DONE();

  const signerAddress = await wallet.getAddress();
  console.log(`[${LABEL}] Signer             : ${signerAddress}`);
  console.log(`[${LABEL}] OnboardingRegistry : ${ONBOARDING_REG}`);
  console.log(`[${LABEL}] ClientSetupOracle  : ${SETUP_CONTRACT}`);
  console.log(`[${LABEL}] MCP endpoint       : ${MCP_ENDPOINT}`);
  console.log(`[${LABEL}] EntityAgentId      : ${ENTITY_AGENT_ID}`);
  console.log(`[${LABEL}] AccountAgentId     : ${ACCOUNT_AGENT_ID}`);
  console.log(`[${LABEL}] ProductAgentId     : ${PRODUCT_AGENT_ID}`);
  console.log(`[${LABEL}] Listening for PhaseCompleted events…\n`);

  registry.on('PhaseCompleted', async (...args) => {
    const event = args[args.length - 1];
    const { flowId, phase } = event.args;
    const mask = await registry.phaseBitmask(flowId);

    console.log(`\n[${LABEL}] ← PhaseCompleted  flowId=${flowId}  phase=0x${phase.toString(16)}  mask=0x${mask.toString(16)}`);

    // ALL_REVIEWS_DONE → trigger legal entity setup
    if ((mask & ALL_REVIEWS_DONE) === ALL_REVIEWS_DONE && (mask & ENTITY_SETUP_DONE) === 0n) {
      try {
        console.log(`[${LABEL}]   → setup_legal_entity`);
        const result = await callMcpTool(MCP_ENDPOINT, 'setup_legal_entity', { flow_id: flowId }, flowId);
        const tx = await setupOracle.setupLegalEntity(flowId, ENTITY_AGENT_ID, result.entity_spec_hash);
        await tx.wait();
        console.log(`[${LABEL}]   ✓ setupLegalEntity  tx=${tx.hash}`);
      } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
      return;
    }

    // ENTITY_SETUP_DONE → trigger account setup
    if ((mask & ENTITY_SETUP_DONE) === ENTITY_SETUP_DONE && (mask & ACCOUNT_SETUP_DONE) === 0n) {
      try {
        console.log(`[${LABEL}]   → setup_account`);
        const result = await callMcpTool(MCP_ENDPOINT, 'setup_account', { flow_id: flowId }, flowId);
        const tx = await setupOracle.setupAccount(flowId, ACCOUNT_AGENT_ID, result.account_spec_hash);
        await tx.wait();
        console.log(`[${LABEL}]   ✓ setupAccount  tx=${tx.hash}`);
      } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
      return;
    }

    // ACCOUNT_SETUP_DONE → trigger product setup
    const PRODUCT_SETUP_DONE = 0x20n;
    if ((mask & ACCOUNT_SETUP_DONE) === ACCOUNT_SETUP_DONE && (mask & PRODUCT_SETUP_DONE) === 0n) {
      try {
        console.log(`[${LABEL}]   → setup_products`);
        const result = await callMcpTool(MCP_ENDPOINT, 'setup_products', { flow_id: flowId }, flowId);
        const tx = await setupOracle.setupProducts(flowId, PRODUCT_AGENT_ID, result.product_spec_hash);
        await tx.wait();
        console.log(`[${LABEL}]   ✓ setupProducts  tx=${tx.hash}`);
      } catch (err) { console.error(`[${LABEL}]   ✗ ${err.message}`); }
    }
  });
}

main().catch(err => { console.error(err); process.exit(1); });
