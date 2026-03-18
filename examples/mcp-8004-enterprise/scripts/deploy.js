'use strict';

/**
 * deploy.js  —  Full-stack simulation deployment
 *
 * Deploys all 15 contracts to the running Hardhat node, wires governance,
 * registers all 10 agent cards, and writes simulation-addresses.json.
 *
 * Run AFTER starting the Hardhat node in a separate terminal:
 *   Terminal 1:  npx hardhat node
 *   Terminal 2:  node scripts/deploy.js
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

async function main() {
    const signers  = await hre.ethers.getSigners();
    const deployer = signers[0];
    console.log("Deploying from:", deployer.address);
    console.log();

    // ── 1. IdentityRegistryUpgradeable (UUPS proxy) ───────────────────────────
    const Identity = await hre.ethers.getContractFactory("IdentityRegistryUpgradeable");
    const identity = await hre.upgrades.deployProxy(Identity, [], { initializer: "initialize" });
    await identity.waitForDeployment();
    const identityAddr = await identity.getAddress();
    console.log("IdentityRegistryUpgradeable    →", identityAddr);

    // ── 2. ReputationRegistryUpgradeable (UUPS proxy) ─────────────────────────
    const Reputation = await hre.ethers.getContractFactory("ReputationRegistryUpgradeable");
    const reputation = await hre.upgrades.deployProxy(Reputation, [identityAddr], { initializer: "initialize" });
    await reputation.waitForDeployment();
    const reputationAddr = await reputation.getAddress();
    console.log("ReputationRegistryUpgradeable  →", reputationAddr);

    // ── 3. ParticipantRegistry ────────────────────────────────────────────────
    const ParticipantReg = await hre.ethers.getContractFactory("ParticipantRegistry");
    const participantReg = await ParticipantReg.deploy(deployer.address);
    await participantReg.waitForDeployment();
    const participantAddr = await participantReg.getAddress();
    console.log("ParticipantRegistry            →", participantAddr);

    // ── 4. OnboardingRegistry ─────────────────────────────────────────────────
    const OnboardingReg = await hre.ethers.getContractFactory("OnboardingRegistry");
    const onboardingReg = await OnboardingReg.deploy(deployer.address);
    await onboardingReg.waitForDeployment();
    const onboardingAddr = await onboardingReg.getAddress();
    console.log("OnboardingRegistry             →", onboardingAddr);

    // ── 5. AMLOracle ──────────────────────────────────────────────────────────
    const AMLOracleF = await hre.ethers.getContractFactory("AMLOracle");
    const amlOracle  = await AMLOracleF.deploy(identityAddr, onboardingAddr);
    await amlOracle.waitForDeployment();
    const amlAddr = await amlOracle.getAddress();
    console.log("AMLOracle                      →", amlAddr);

    // ── 6. CreditRiskOracle ───────────────────────────────────────────────────
    const CreditF      = await hre.ethers.getContractFactory("CreditRiskOracle");
    const creditOracle = await CreditF.deploy(identityAddr, onboardingAddr);
    await creditOracle.waitForDeployment();
    const creditAddr = await creditOracle.getAddress();
    console.log("CreditRiskOracle               →", creditAddr);

    // ── 7. LegalOracle ────────────────────────────────────────────────────────
    const LegalF      = await hre.ethers.getContractFactory("LegalOracle");
    const legalOracle = await LegalF.deploy(identityAddr, onboardingAddr);
    await legalOracle.waitForDeployment();
    const legalAddr = await legalOracle.getAddress();
    console.log("LegalOracle                    →", legalAddr);

    // ── 8. ClientSetupOracle ──────────────────────────────────────────────────
    const SetupF      = await hre.ethers.getContractFactory("ClientSetupOracle");
    const setupOracle = await SetupF.deploy(identityAddr, onboardingAddr);
    await setupOracle.waitForDeployment();
    const setupAddr = await setupOracle.getAddress();
    console.log("ClientSetupOracle              →", setupAddr);

    // ── 9. FlowAuthorizationRegistry ─────────────────────────────────────────
    const FlowAuthF  = await hre.ethers.getContractFactory("FlowAuthorizationRegistry");
    const flowAuth   = await FlowAuthF.deploy();
    await flowAuth.waitForDeployment();
    const flowAuthAddr = await flowAuth.getAddress();
    console.log("FlowAuthorizationRegistry      →", flowAuthAddr);

    // ── 10. ReputationGate ────────────────────────────────────────────────────
    const RepGateF  = await hre.ethers.getContractFactory("ReputationGate");
    const repGate   = await RepGateF.deploy(reputationAddr);
    await repGate.waitForDeployment();
    const repGateAddr = await repGate.getAddress();
    console.log("ReputationGate                 →", repGateAddr);

    // ── 11. AutonomyBoundsRegistry ────────────────────────────────────────────
    const BoundsF        = await hre.ethers.getContractFactory("AutonomyBoundsRegistry");
    const autonomyBounds = await BoundsF.deploy();
    await autonomyBounds.waitForDeployment();
    const autonomyBoundsAddr = await autonomyBounds.getAddress();
    console.log("AutonomyBoundsRegistry         →", autonomyBoundsAddr);

    // ── 12. ExecutionTraceLog ─────────────────────────────────────────────────
    const TraceLogF = await hre.ethers.getContractFactory("ExecutionTraceLog");
    const traceLog  = await TraceLogF.deploy();
    await traceLog.waitForDeployment();
    const traceLogAddr = await traceLog.getAddress();
    console.log("ExecutionTraceLog              →", traceLogAddr);

    // ── 13. ActionPermitRegistry ──────────────────────────────────────────────
    const ActionPermitF = await hre.ethers.getContractFactory("ActionPermitRegistry");
    const actionPermit  = await ActionPermitF.deploy();
    await actionPermit.waitForDeployment();
    const actionPermitAddr = await actionPermit.getAddress();
    console.log("ActionPermitRegistry           →", actionPermitAddr);

    // ── 14. PromptRegistry ────────────────────────────────────────────────────
    const PromptRegF = await hre.ethers.getContractFactory("PromptRegistry");
    const promptReg  = await PromptRegF.deploy();
    await promptReg.waitForDeployment();
    const promptRegAddr = await promptReg.getAddress();
    console.log("PromptRegistry                 →", promptRegAddr);

    // ── 15. DatasetRegistry ───────────────────────────────────────────────────
    const DatasetRegF = await hre.ethers.getContractFactory("DatasetRegistry");
    const datasetReg  = await DatasetRegF.deploy();
    await datasetReg.waitForDeployment();
    const datasetRegAddr = await datasetReg.getAddress();
    console.log("DatasetRegistry                →", datasetRegAddr);

    console.log("\n── Wiring ───────────────────────────────────────────────────────");

    // OnboardingRegistry: register the 4 oracle contracts + deployer
    // (deployer acts as the flow-driver's on-chain initiator in flow-driver.js)
    await (await onboardingReg.setOracle(amlAddr,           true)).wait();
    await (await onboardingReg.setOracle(creditAddr,        true)).wait();
    await (await onboardingReg.setOracle(legalAddr,         true)).wait();
    await (await onboardingReg.setOracle(setupAddr,         true)).wait();
    await (await onboardingReg.setOracle(deployer.address,  true)).wait();
    console.log("OnboardingRegistry: 4 oracle contracts + deployer registered ✓");

    // FlowAuthorizationRegistry bilateral consent gate
    await (await flowAuth.setGovernanceContracts(identityAddr, participantAddr)).wait();
    console.log("FlowAuthorizationRegistry.setGovernanceContracts ✓");

    // ActionPermitRegistry institution-credentialed approver gate
    await (await actionPermit.setParticipantRegistry(participantAddr)).wait();
    console.log("ActionPermitRegistry.setParticipantRegistry ✓");

    // ExecutionTraceLog flow policy
    await (await traceLog.setMaxHops(50)).wait();
    await (await traceLog.setLoopDetection(true)).wait();
    console.log("ExecutionTraceLog: maxHops=50, loopDetection=true ✓");

    // ── Agent registration ─────────────────────────────────────────────────────

    // Capability → oracle mapping (plan §1)
    const capToOracle = {
        'aml_review':         amlAddr,
        'credit_review':      creditAddr,
        'legal_review':       legalAddr,
        'setup_legal_entity': setupAddr,
        'setup_account':      setupAddr,
        'setup_products':     setupAddr,
    };

    const agentsDir  = path.join(__dirname, "..", "agents");
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith(".json")).sort();

    console.log(`\n── Registering ${agentFiles.length} agents (signers[1..${agentFiles.length}]) ─────────────────`);

    const agentRecords = [];

    for (let i = 0; i < agentFiles.length; i++) {
        const file    = agentFiles[i];
        const owner   = signers[i + 1] ?? signers[0];
        const rawCard = fs.readFileSync(path.join(agentsDir, file));
        const card    = JSON.parse(rawCard);
        const uri     = `data:application/json;base64,${Buffer.from(rawCard).toString("base64")}`;

        // Pick oracle for first matching capability
        let oracleAddr = null;
        for (const cap of (card.capabilities || [])) {
            if (capToOracle[cap]) { oracleAddr = capToOracle[cap]; break; }
        }

        let tx;
        if (oracleAddr) {
            tx = await identity.connect(owner)["register(string,(string,bytes)[],address)"](uri, [], oracleAddr);
        } else {
            tx = await identity.connect(owner)["register(string,(string,bytes)[])"](uri, []);
        }
        const receipt = await tx.wait();

        const regEvent = receipt.logs
            .map(log => { try { return identity.interface.parseLog(log); } catch { return null; } })
            .find(e => e?.name === "Registered");
        const agentId = regEvent?.args?.agentId ?? BigInt(i);

        // Commit card hash on-chain (Concept 9 — Agent Card Integrity)
        const cardHash = hre.ethers.keccak256(rawCard);
        await (await identity.connect(owner).setCardHash(agentId, cardHash)).wait();

        const oracleNote = oracleAddr ? `oracle=${oracleAddr}` : "no oracle";
        console.log(`  ✓ ${file.padEnd(42)} agentId=${agentId.toString().padEnd(3)} ${oracleNote}`);

        agentRecords.push({
            file,
            name:         card.name,
            capabilities: card.capabilities || [],
            agentId:      agentId.toString(),
            wallet:       owner.address,
            cardHash,
        });
    }

    // ── Register LangChain prompt hash v1 (NOT activated — activate when Python bridges go live) ──
    console.log("\n── Registering LangChain prompt hash v1 ─────────────────────────────────");

    const mcpDir     = path.join(__dirname, '..', 'agents', 'mcp');
    const amlSpec    = JSON.parse(fs.readFileSync(path.join(mcpDir, 'aml-review.mcp.json'),   'utf8'));
    const creditSpec = JSON.parse(fs.readFileSync(path.join(mcpDir, 'credit-risk.mcp.json'),  'utf8'));
    const legalSpec  = JSON.parse(fs.readFileSync(path.join(mcpDir, 'legal-review.mcp.json'), 'utf8'));

    const CAP_AML_REVIEW    = hre.ethers.id('aml_review');
    const CAP_CREDIT_REVIEW = hre.ethers.id('credit_review');
    const CAP_LEGAL_REVIEW  = hre.ethers.id('legal_review');

    function langchainHash(spec) {
        const msgs = spec.prompts?.[0]?.langchain_messages;
        if (!msgs) throw new Error(`No langchain_messages found in spec: ${spec.name}`);
        // JSON.stringify (no spaces) matches Python json.dumps(separators=(',',':'))
        const canonical = JSON.stringify(msgs);
        return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(canonical));
    }

    await (await promptReg.registerPrompt(CAP_AML_REVIEW,    langchainHash(amlSpec),    'agents/mcp/aml-review.mcp.json#v1-langchain')).wait();
    await (await promptReg.registerPrompt(CAP_CREDIT_REVIEW, langchainHash(creditSpec), 'agents/mcp/credit-risk.mcp.json#v1-langchain')).wait();
    await (await promptReg.registerPrompt(CAP_LEGAL_REVIEW,  langchainHash(legalSpec),  'agents/mcp/legal-review.mcp.json#v1-langchain')).wait();
    console.log("PromptRegistry: LangChain hash v1 registered for AML, Credit, Legal (not yet activated) ✓");
    console.log("  → To activate: promptReg.setActiveVersion(CAP_*, 0)  (version 0 = first registered)");
    console.log("  → Rollback:    promptReg.deactivate(CAP_*)");

    // ── Write simulation-addresses.json ───────────────────────────────────────
    const addresses = {
        identityRegistry:          identityAddr,
        reputationRegistry:        reputationAddr,
        participantRegistry:       participantAddr,
        onboardingRegistry:        onboardingAddr,
        amlOracle:                 amlAddr,
        creditRiskOracle:          creditAddr,
        legalOracle:               legalAddr,
        clientSetupOracle:         setupAddr,
        flowAuthorizationRegistry: flowAuthAddr,
        reputationGate:            repGateAddr,
        autonomyBoundsRegistry:    autonomyBoundsAddr,
        executionTraceLog:         traceLogAddr,
        actionPermitRegistry:      actionPermitAddr,
        promptRegistry:            promptRegAddr,
        datasetRegistry:           datasetRegAddr,
        deployer:                  deployer.address,
        agents:                    agentRecords,
    };

    const outPath = path.join(__dirname, "..", "simulation-addresses.json");
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
    console.log(`\n✓ Written: ${outPath}`);

    // ── Print bridge launch command ────────────────────────────────────────────
    const byCapFirst = (cap) => agentRecords.find(a => a.capabilities.includes(cap));
    const idOf       = (cap) => byCapFirst(cap)?.agentId ?? '?';

    console.log("\n══════════════════════════════════════════════════════════════");
    console.log(" Terminal 4 — launch bridges (replace <YOUR_PRIVATE_KEY>):");
    console.log("══════════════════════════════════════════════════════════════");
    console.log(`node agents_implementation/launch-bridges.js \\`);
    console.log(`  --rpc                 http://127.0.0.1:8545 \\`);
    console.log(`  --privkey             0x<YOUR_PRIVATE_KEY> \\`);
    console.log(`  --onboarding-registry ${onboardingAddr} \\`);
    console.log(`  --aml-contract        ${amlAddr} \\`);
    console.log(`  --credit-contract     ${creditAddr} \\`);
    console.log(`  --legal-contract      ${legalAddr} \\`);
    console.log(`  --setup-contract      ${setupAddr} \\`);
    console.log(`  --identity-registry   ${identityAddr} \\`);
    console.log(`  --flow-auth           ${flowAuthAddr} \\`);
    console.log(`  --reputation-gate     ${repGateAddr} \\`);
    console.log(`  --autonomy-bounds     ${autonomyBoundsAddr} \\`);
    console.log(`  --action-permit       ${actionPermitAddr} \\`);
    console.log(`  --aml-agent-id        ${idOf('aml_review')} \\`);
    console.log(`  --credit-agent-id     ${idOf('credit_review')} \\`);
    console.log(`  --legal-agent-id      ${idOf('legal_review')} \\`);
    console.log(`  --entity-agent-id     ${idOf('setup_legal_entity')} \\`);
    console.log(`  --account-agent-id    ${idOf('setup_account')} \\`);
    console.log(`  --product-agent-id    ${idOf('setup_products')} \\`);
    console.log(`  --hf-doc-agent-id     ${idOf('submit_documents')} \\`);
    console.log(`  --hf-credit-agent-id  ${idOf('credit_negotiation')} \\`);
    console.log(`  --hf-legal-agent-id   ${idOf('legal_negotiation')}`);
    console.log("══════════════════════════════════════════════════════════════");
    console.log("\nNext: npx hardhat run scripts/flow-driver.js --network localhost");
}

main().catch(err => { console.error(err); process.exitCode = 1; });
