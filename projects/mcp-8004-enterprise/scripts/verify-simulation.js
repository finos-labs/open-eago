'use strict';

/**
 * verify-simulation.js  —  Combined deploy + flow verification in a single run
 *
 * Run with:
 *   npx hardhat run scripts/verify-simulation.js
 *
 * Deploys all contracts and drives the complete B2B onboarding flow in one
 * Hardhat session (no separate node required). Exit code 0 = success.
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

const SIM_HASH = (l) => hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`simulation:${l}`));

function parseEvent(receipt, iface, eventName) {
    return receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(e => e?.name === eventName);
}

async function main() {
    const signers  = await hre.ethers.getSigners();
    const deployer = signers[0];
    const bankHuman = signers[0];
    const hfHuman   = signers[11];

    // ── Deploy (same logic as deploy.js) ─────────────────────────────────────
    console.log("── Deploying contracts…");

    const Identity = await hre.ethers.getContractFactory("IdentityRegistryUpgradeable");
    const identity = await hre.upgrades.deployProxy(Identity, [], { initializer: "initialize" });
    await identity.waitForDeployment();
    const identityAddr = await identity.getAddress();

    const Reputation = await hre.ethers.getContractFactory("ReputationRegistryUpgradeable");
    const reputation = await hre.upgrades.deployProxy(Reputation, [identityAddr], { initializer: "initialize" });
    await reputation.waitForDeployment();
    const reputationAddr = await reputation.getAddress();

    const participantReg = await (await hre.ethers.getContractFactory("ParticipantRegistry")).deploy(deployer.address);
    await participantReg.waitForDeployment();
    const participantAddr = await participantReg.getAddress();

    const onboardingReg = await (await hre.ethers.getContractFactory("OnboardingRegistry")).deploy(deployer.address);
    await onboardingReg.waitForDeployment();
    const onboardingAddr = await onboardingReg.getAddress();

    const amlOracle    = await (await hre.ethers.getContractFactory("AMLOracle")).deploy(identityAddr, onboardingAddr);
    const creditOracle = await (await hre.ethers.getContractFactory("CreditRiskOracle")).deploy(identityAddr, onboardingAddr);
    const legalOracle  = await (await hre.ethers.getContractFactory("LegalOracle")).deploy(identityAddr, onboardingAddr);
    const setupOracle  = await (await hre.ethers.getContractFactory("ClientSetupOracle")).deploy(identityAddr, onboardingAddr);

    await Promise.all([
        amlOracle.waitForDeployment(),
        creditOracle.waitForDeployment(),
        legalOracle.waitForDeployment(),
        setupOracle.waitForDeployment(),
    ]);

    const amlAddr   = await amlOracle.getAddress();
    const creditAddr = await creditOracle.getAddress();
    const legalAddr  = await legalOracle.getAddress();
    const setupAddr  = await setupOracle.getAddress();

    // Register oracle contracts + deployer in OnboardingRegistry
    await (await onboardingReg.setOracle(amlAddr,          true)).wait();
    await (await onboardingReg.setOracle(creditAddr,       true)).wait();
    await (await onboardingReg.setOracle(legalAddr,        true)).wait();
    await (await onboardingReg.setOracle(setupAddr,        true)).wait();
    await (await onboardingReg.setOracle(deployer.address, true)).wait();

    // ── Register agents (same capability→oracle mapping as deploy.js) ─────────
    const capToOracle = {
        'aml_review': amlAddr, 'credit_review': creditAddr, 'legal_review': legalAddr,
        'setup_legal_entity': setupAddr, 'setup_account': setupAddr, 'setup_products': setupAddr,
    };

    const agentsDir  = path.join(__dirname, "..", "agents");
    const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith(".json")).sort();

    const agentRecords = [];
    for (let i = 0; i < agentFiles.length; i++) {
        const file    = agentFiles[i];
        const owner   = signers[i + 1] ?? signers[0];
        const rawCard = fs.readFileSync(path.join(agentsDir, file));
        const card    = JSON.parse(rawCard);
        const uri     = `data:application/json;base64,${Buffer.from(rawCard).toString("base64")}`;

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
        const receipt  = await tx.wait();
        const regEvent = receipt.logs
            .map(l => { try { return identity.interface.parseLog(l); } catch { return null; } })
            .find(e => e?.name === "Registered");
        const agentId  = regEvent?.args?.agentId ?? BigInt(i);

        const cardHash = hre.ethers.keccak256(rawCard);
        await (await identity.connect(owner).setCardHash(agentId, cardHash)).wait();

        agentRecords.push({ file, capabilities: card.capabilities || [], agentId: agentId.toString(), wallet: owner.address, cardHash });
    }

    console.log(`  ✓ ${agentFiles.length} agents registered\n`);

    // ── Build lookup tables (mirrors flow-driver.js) ──────────────────────────
    const signerFor  = (w) => signers.find(s => s.address.toLowerCase() === w.toLowerCase());
    const agentByCap = (c) => agentRecords.find(a => a.capabilities.includes(c));

    const amlAgent     = agentByCap('aml_review');
    const creditAgent  = agentByCap('credit_review');
    const legalAgent   = agentByCap('legal_review');
    const entityAgent  = agentByCap('setup_legal_entity');
    const accountAgent = agentByCap('setup_account');
    const productAgent = agentByCap('setup_products');
    const hfDocAgent   = agentByCap('submit_documents');
    const hfLegalAgent = agentByCap('legal_negotiation');

    const amlSigner     = signerFor(amlAgent.wallet);
    const creditSigner  = signerFor(creditAgent.wallet);
    const legalSigner   = signerFor(legalAgent.wallet);
    const entitySigner  = signerFor(entityAgent.wallet);
    const accountSigner = signerFor(accountAgent.wallet);
    const productSigner = signerFor(productAgent.wallet);
    const hfLegalSigner = signerFor(hfLegalAgent.wallet);

    // ── Drive the flow (same logic as flow-driver.js) ─────────────────────────
    const flowId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`verify:${Date.now()}`));
    console.log(`── Driving flow  flowId=${flowId.slice(0, 18)}…\n`);

    // [1] Initiate
    await (await onboardingReg.connect(bankHuman).initiateOnboarding(flowId, hfHuman.address)).wait();
    console.log("[1] ✓ OnboardingInitiated");

    // [2] AML
    const amlReqTx      = await amlOracle.connect(amlSigner).requestAMLReview(
        flowId, BigInt(amlAgent.agentId), BigInt(hfDocAgent.agentId)
    );
    const amlReqReceipt = await amlReqTx.wait();
    const amlReqEvt     = parseEvent(amlReqReceipt, amlOracle.interface, "AMLReviewRequested");
    const amlRequestId  = amlReqEvt.args.requestId;

    await (await amlOracle.connect(amlSigner).submitRecommendation(
        amlRequestId, BigInt(amlAgent.agentId), SIM_HASH("aml"), amlAgent.cardHash
    )).wait();
    await (await amlOracle.connect(bankHuman).clear(amlRequestId, BigInt(amlAgent.agentId))).wait();
    console.log("[2] ✓ AML cleared");

    // [3] Credit
    const creditReqTx      = await creditOracle.connect(creditSigner).requestCreditReview(
        flowId, BigInt(creditAgent.agentId), BigInt(hfDocAgent.agentId)
    );
    const creditReqReceipt = await creditReqTx.wait();
    const creditRequestId  = parseEvent(creditReqReceipt, creditOracle.interface, "CreditReviewRequested").args.requestId;

    await (await creditOracle.connect(creditSigner).submitRecommendation(
        creditRequestId, BigInt(creditAgent.agentId), SIM_HASH("credit"), creditAgent.cardHash
    )).wait();
    await (await creditOracle.connect(bankHuman).approve(creditRequestId, BigInt(creditAgent.agentId))).wait();
    console.log("[3] ✓ Credit approved");

    // [4] Legal (with one draft/markup negotiation round)
    const legalReqTx      = await legalOracle.connect(legalSigner).requestLegalReview(
        flowId, BigInt(legalAgent.agentId), BigInt(hfLegalAgent.agentId)
    );
    const legalReqReceipt = await legalReqTx.wait();
    const legalRequestId  = parseEvent(legalReqReceipt, legalOracle.interface, "LegalReviewRequested").args.requestId;

    await (await legalOracle.connect(legalSigner).issueDraft(
        legalRequestId, BigInt(legalAgent.agentId), SIM_HASH("draft-v1"), legalAgent.cardHash
    )).wait();
    await (await legalOracle.connect(hfLegalSigner).submitMarkup(
        legalRequestId, BigInt(hfLegalAgent.agentId), SIM_HASH("markup-v1"), hfLegalAgent.cardHash
    )).wait();
    await (await legalOracle.connect(legalSigner).submitRecommendation(
        legalRequestId, BigInt(legalAgent.agentId), SIM_HASH("contract-final"), legalAgent.cardHash
    )).wait();
    await (await legalOracle.connect(bankHuman).approveBankSide(legalRequestId, BigInt(legalAgent.agentId))).wait();
    await (await legalOracle.connect(hfHuman).approveClientSide(legalRequestId, BigInt(hfLegalAgent.agentId))).wait();
    await (await legalOracle.connect(bankHuman).execute(legalRequestId)).wait();
    console.log("[4] ✓ Legal executed  (bilateral approval)");

    // [5] Verify reviews done
    const maskReviews = await onboardingReg.phaseBitmask(flowId);
    if ((Number(maskReviews) & 0x07) !== 0x07) throw new Error(`Expected 0x07, got 0x${Number(maskReviews).toString(16)}`);
    console.log(`[5] ✓ ALL_REVIEWS_DONE  phaseBitmask=0x${Number(maskReviews).toString(16)}`);

    // [6] Sequential setup
    await (await setupOracle.connect(entitySigner).setupLegalEntity(
        flowId, BigInt(entityAgent.agentId), SIM_HASH("entity"), entityAgent.cardHash
    )).wait();
    await (await setupOracle.connect(accountSigner).setupAccount(
        flowId, BigInt(accountAgent.agentId), SIM_HASH("account"), accountAgent.cardHash
    )).wait();
    const productTx      = await setupOracle.connect(productSigner).setupProducts(
        flowId, BigInt(productAgent.agentId), SIM_HASH("products"), productAgent.cardHash
    );
    const productReceipt = await productTx.wait();
    console.log("[6] ✓ All setup phases complete");

    // [7] ReadyToTransact
    const finalMask = await onboardingReg.phaseBitmask(flowId);
    if (Number(finalMask) !== 0x3F) throw new Error(`Expected 0x3F, got 0x${Number(finalMask).toString(16)}`);

    const rttEvt = parseEvent(productReceipt, onboardingReg.interface, "ReadyToTransact");
    if (!rttEvt) throw new Error("ReadyToTransact event not found in receipt");

    console.log(`\n[7] ✓ ReadyToTransact  phaseBitmask=0x3F`);
    console.log(`    flowId         : ${rttEvt.args.flowId}`);
    console.log(`    clientInitiator: ${rttEvt.args.clientInitiator}`);
    console.log("\n✓ Full simulation verified successfully.\n");
}

main().catch(err => { console.error("\n✗", err.message); process.exitCode = 1; });
