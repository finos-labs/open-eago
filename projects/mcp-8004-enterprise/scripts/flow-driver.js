'use strict';

/**
 * flow-driver.js  —  Full B2B onboarding simulation
 *
 * Drives the complete onboarding lifecycle end-to-end:
 *   AML review → Credit review → Legal review → Legal entity setup
 *   → Account setup → Product setup → ReadyToTransact ✓
 *
 * Requires simulation-addresses.json (written by scripts/deploy.js).
 *
 * Run with:
 *   npx hardhat run scripts/flow-driver.js --network localhost
 *
 * Signer assignment (mirrors deploy.js registration order):
 *   signers[0]       — deployer / bank human approver (Tier 2 for AML + Credit + Legal bank-side)
 *   signers[1..10]   — agent wallets (same order as alphabetically-sorted agents/*.json)
 *   signers[11]      — HF institution human approver (Tier 2 for Legal client-side)
 */

const hre  = require("hardhat");
const fs   = require("fs");
const path = require("path");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Poll checkFn every intervalMs until it returns true, or throw after timeoutMs. */
async function waitForCondition(checkFn, label = '', intervalMs = 2000, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await checkFn()) return;
        process.stdout.write(`  polling: ${label}...\r`);
        await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Timeout (${timeoutMs}ms) waiting for: ${label}`);
}

/** Deterministic simulation payload hash — stands in for real off-chain data. */
const SIM_HASH = (label) => hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`simulation:${label}`));

/** Parse a named event from a transaction receipt. */
function parseEvent(receipt, iface, eventName) {
    return receipt.logs
        .map(l => { try { return iface.parseLog(l); } catch { return null; } })
        .find(e => e?.name === eventName);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    // ── Load addresses ────────────────────────────────────────────────────────
    const addrFile = path.join(__dirname, "..", "simulation-addresses.json");
    if (!fs.existsSync(addrFile)) {
        throw new Error("simulation-addresses.json not found — run `node scripts/deploy.js` first");
    }
    const addr = JSON.parse(fs.readFileSync(addrFile, "utf8"));

    // ── Signers ───────────────────────────────────────────────────────────────
    const signers   = await hre.ethers.getSigners();
    const bankHuman = signers[0];   // deployer — bank Tier 2 human approver
    const hfHuman   = signers[11];  // HF institution Tier 2 human approver

    // Find signer whose address matches a wallet stored in simulation-addresses.json
    const signerFor = (walletAddr) => {
        const s = signers.find(s => s.address.toLowerCase() === walletAddr.toLowerCase());
        if (!s) throw new Error(`No signer found for wallet ${walletAddr}`);
        return s;
    };

    // Find agent record by capability tag
    const agentByCap = (cap) => {
        const a = addr.agents.find(a => a.capabilities.includes(cap));
        if (!a) throw new Error(`No agent with capability "${cap}" in simulation-addresses.json`);
        return a;
    };

    // Agent records
    const amlAgent     = agentByCap('aml_review');
    const creditAgent  = agentByCap('credit_review');
    const legalAgent   = agentByCap('legal_review');
    const entityAgent  = agentByCap('setup_legal_entity');
    const accountAgent = agentByCap('setup_account');
    const productAgent = agentByCap('setup_products');
    const hfDocAgent   = agentByCap('submit_documents');
    const hfLegalAgent = agentByCap('legal_negotiation');

    // Agent signers (matched by wallet address)
    const amlSigner     = signerFor(amlAgent.wallet);
    const creditSigner  = signerFor(creditAgent.wallet);
    const legalSigner   = signerFor(legalAgent.wallet);
    const entitySigner  = signerFor(entityAgent.wallet);
    const accountSigner = signerFor(accountAgent.wallet);
    const productSigner = signerFor(productAgent.wallet);
    const hfLegalSigner = signerFor(hfLegalAgent.wallet);

    // ── Contract instances ────────────────────────────────────────────────────
    const onboardingReg = await hre.ethers.getContractAt("OnboardingRegistry",  addr.onboardingRegistry);
    const amlOracle     = await hre.ethers.getContractAt("AMLOracle",           addr.amlOracle);
    const creditOracle  = await hre.ethers.getContractAt("CreditRiskOracle",    addr.creditRiskOracle);
    const legalOracle   = await hre.ethers.getContractAt("LegalOracle",         addr.legalOracle);
    const setupOracle   = await hre.ethers.getContractAt("ClientSetupOracle",   addr.clientSetupOracle);

    // ── Generate unique flowId ────────────────────────────────────────────────
    const flowId = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(`sim:${Date.now()}`));

    console.log("\n════════════════════════════════════════════════════════════════");
    console.log(" B2B Onboarding Simulation  —  ERC-8004 + MCP Demo");
    console.log("════════════════════════════════════════════════════════════════");
    console.log(` flowId         : ${flowId}`);
    console.log(` bankHuman      : ${bankHuman.address}  (deployer / Tier-2 approver)`);
    console.log(` hfHuman        : ${hfHuman.address}  (HF Tier-2 approver)`);
    console.log(` onboardingReg  : ${addr.onboardingRegistry}`);
    console.log(` amlOracle      : ${addr.amlOracle}  (agentId=${amlAgent.agentId})`);
    console.log(` creditOracle   : ${addr.creditRiskOracle}  (agentId=${creditAgent.agentId})`);
    console.log(` legalOracle    : ${addr.legalOracle}  (agentId=${legalAgent.agentId})`);
    console.log(` setupOracle    : ${addr.clientSetupOracle}`);
    console.log("════════════════════════════════════════════════════════════════\n");

    // ── [1] Initiate onboarding ───────────────────────────────────────────────
    console.log("[1] Initiating onboarding flow…");

    const initTx      = await onboardingReg.connect(bankHuman).initiateOnboarding(flowId, hfHuman.address);
    const initReceipt = await initTx.wait();
    const initEvt     = parseEvent(initReceipt, onboardingReg.interface, "OnboardingInitiated");
    console.log(`  ✓ OnboardingInitiated  initiator=${initEvt?.args?.clientInitiator}  tx=${initTx.hash}`);

    // ── [2] AML review ────────────────────────────────────────────────────────
    console.log("\n[2] AML review…");

    // 2a. Bank AML agent opens the request
    const amlReqTx      = await amlOracle.connect(amlSigner).requestAMLReview(
        flowId, BigInt(amlAgent.agentId), BigInt(hfDocAgent.agentId)
    );
    const amlReqReceipt = await amlReqTx.wait();
    const amlReqEvt     = parseEvent(amlReqReceipt, amlOracle.interface, "AMLReviewRequested");
    const amlRequestId  = amlReqEvt.args.requestId;
    console.log(`  ✓ requestAMLReview       requestId=${amlRequestId}`);

    // 2b. Bank AML agent submits screening recommendation → InHumanReview
    await (await amlOracle.connect(amlSigner).submitRecommendation(
        amlRequestId, BigInt(amlAgent.agentId), SIM_HASH("aml-result"), amlAgent.cardHash
    )).wait();
    console.log("  ✓ submitRecommendation   status → InHumanReview");

    // 2c. Bank human approver clears AML → sets PHASE_AML_CLEARED
    await (await amlOracle.connect(bankHuman).clear(amlRequestId, BigInt(amlAgent.agentId))).wait();
    console.log("  ✓ clear                  status → Cleared  [PHASE_AML_CLEARED 0x01]");

    // ── [3] Credit review ─────────────────────────────────────────────────────
    console.log("\n[3] Credit review…");

    // 3a. Bank credit agent opens the request
    const creditReqTx      = await creditOracle.connect(creditSigner).requestCreditReview(
        flowId, BigInt(creditAgent.agentId), BigInt(hfDocAgent.agentId)
    );
    const creditReqReceipt = await creditReqTx.wait();
    const creditReqEvt     = parseEvent(creditReqReceipt, creditOracle.interface, "CreditReviewRequested");
    const creditRequestId  = creditReqEvt.args.requestId;
    console.log(`  ✓ requestCreditReview    requestId=${creditRequestId}`);

    // 3b. Bank credit agent submits assessment recommendation → InHumanReview
    await (await creditOracle.connect(creditSigner).submitRecommendation(
        creditRequestId, BigInt(creditAgent.agentId), SIM_HASH("credit-result"), creditAgent.cardHash
    )).wait();
    console.log("  ✓ submitRecommendation   status → InHumanReview");

    // 3c. Bank human approver approves credit → sets PHASE_CREDIT_APPROVED
    await (await creditOracle.connect(bankHuman).approve(creditRequestId, BigInt(creditAgent.agentId))).wait();
    console.log("  ✓ approve                status → Approved  [PHASE_CREDIT_APPROVED 0x02]");

    // ── [4] Legal review ──────────────────────────────────────────────────────
    console.log("\n[4] Legal review…");

    // 4a. Bank legal agent opens the request
    const legalReqTx      = await legalOracle.connect(legalSigner).requestLegalReview(
        flowId, BigInt(legalAgent.agentId), BigInt(hfLegalAgent.agentId)
    );
    const legalReqReceipt = await legalReqTx.wait();
    const legalReqEvt     = parseEvent(legalReqReceipt, legalOracle.interface, "LegalReviewRequested");
    const legalRequestId  = legalReqEvt.args.requestId;
    console.log(`  ✓ requestLegalReview     requestId=${legalRequestId}`);

    // 4b. Bank legal agent issues contract draft → DraftIssued
    await (await legalOracle.connect(legalSigner).issueDraft(
        legalRequestId, BigInt(legalAgent.agentId), SIM_HASH("contract-v1"), legalAgent.cardHash
    )).wait();
    console.log("  ✓ issueDraft             status → DraftIssued");

    // 4c. HF legal agent submits markup → Pending (one negotiation round)
    await (await legalOracle.connect(hfLegalSigner).submitMarkup(
        legalRequestId, BigInt(hfLegalAgent.agentId), SIM_HASH("markup-v1"), hfLegalAgent.cardHash
    )).wait();
    console.log("  ✓ submitMarkup (HF)      status → Pending  (negotiation round 1)");

    // 4d. Bank legal agent submits final recommendation → InHumanReview
    await (await legalOracle.connect(legalSigner).submitRecommendation(
        legalRequestId, BigInt(legalAgent.agentId), SIM_HASH("contract-final"), legalAgent.cardHash
    )).wait();
    console.log("  ✓ submitRecommendation   status → InHumanReview");

    // 4e. Bilateral Tier-2 approval
    await (await legalOracle.connect(bankHuman).approveBankSide(legalRequestId, BigInt(legalAgent.agentId))).wait();
    console.log("  ✓ approveBankSide        bankApproved=true");

    await (await legalOracle.connect(hfHuman).approveClientSide(legalRequestId, BigInt(hfLegalAgent.agentId))).wait();
    console.log("  ✓ approveClientSide      clientApproved=true");

    // 4f. Execute bilateral contract → sets PHASE_LEGAL_EXECUTED (also emits ReadyToTransact after setup)
    await (await legalOracle.connect(bankHuman).execute(legalRequestId)).wait();
    console.log("  ✓ execute                status → Executed  [PHASE_LEGAL_EXECUTED 0x04]");

    // ── [5] Wait for ALL_REVIEWS_DONE (phaseBitmask == 0x07) ─────────────────
    console.log("\n[5] Confirming phaseBitmask >= 0x07 (ALL_REVIEWS_DONE)…");
    await waitForCondition(
        async () => (Number(await onboardingReg.phaseBitmask(flowId)) & 0x07) === 0x07,
        "ALL_REVIEWS_DONE",
        500,
        15000
    );
    const maskReviews = await onboardingReg.phaseBitmask(flowId);
    console.log(`  ✓ phaseBitmask=0x${Number(maskReviews).toString(16).padStart(2, '0')}  (AML ✓  Credit ✓  Legal ✓)`);

    // ── [6] Sequential client setup phases ───────────────────────────────────
    console.log("\n[6] Client setup phases (sequential, gated by bitmask)…");

    // Phase 1 — Legal entity setup (requires ALL_REVIEWS_DONE)
    const entityTx = await setupOracle.connect(entitySigner).setupLegalEntity(
        flowId, BigInt(entityAgent.agentId), SIM_HASH("entity-spec"), entityAgent.cardHash
    );
    await entityTx.wait();
    console.log("  ✓ setupLegalEntity       [PHASE_ENTITY_SETUP_DONE 0x08]");

    // Phase 2 — Account setup (requires ENTITY_SETUP_DONE)
    const accountTx = await setupOracle.connect(accountSigner).setupAccount(
        flowId, BigInt(accountAgent.agentId), SIM_HASH("account-spec"), accountAgent.cardHash
    );
    await accountTx.wait();
    console.log("  ✓ setupAccount           [PHASE_ACCOUNT_SETUP_DONE 0x10]");

    // Phase 3 — Product setup (requires ACCOUNT_SETUP_DONE); triggers ReadyToTransact
    const productTx      = await setupOracle.connect(productSigner).setupProducts(
        flowId, BigInt(productAgent.agentId), SIM_HASH("product-spec"), productAgent.cardHash
    );
    const productReceipt = await productTx.wait();
    console.log("  ✓ setupProducts          [PHASE_PRODUCT_SETUP_DONE 0x20]");

    // ── [7] Confirm ReadyToTransact ───────────────────────────────────────────
    console.log("\n[7] Confirming ReadyToTransact…");

    const finalMask = await onboardingReg.phaseBitmask(flowId);
    if (Number(finalMask) !== 0x3F) {
        throw new Error(`Expected phaseBitmask=0x3F but got 0x${Number(finalMask).toString(16)}`);
    }

    // ReadyToTransact is emitted by OnboardingRegistry inside setPhaseComplete(),
    // triggered transitively by setupOracle.setupProducts() — check the receipt.
    const rttEvt = parseEvent(productReceipt, onboardingReg.interface, "ReadyToTransact");

    console.log("\n════════════════════════════════════════════════════════════════");
    console.log(" ✓  ReadyToTransact");
    if (rttEvt) {
        console.log(`    flowId          : ${rttEvt.args.flowId}`);
        console.log(`    clientInitiator : ${rttEvt.args.clientInitiator}`);
    }
    console.log(`    phaseBitmask    : 0x${Number(finalMask).toString(16).toUpperCase()} (ALL_PHASES_DONE = 0x3F ✓)`);
    console.log("════════════════════════════════════════════════════════════════\n");

    // ── Phase summary ─────────────────────────────────────────────────────────
    const phases = [
        [0x01, "AML cleared          "],
        [0x02, "Credit approved      "],
        [0x04, "Legal executed       "],
        [0x08, "Legal entity setup   "],
        [0x10, "Account setup        "],
        [0x20, "Product setup        "],
    ];
    for (const [bit, label] of phases) {
        const done = (Number(finalMask) & bit) === bit;
        console.log(`  ${done ? "✓" : "✗"}  ${label} (0x${bit.toString(16).padStart(2, '0')})`);
    }
    console.log();
}

main().catch(err => { console.error(err); process.exitCode = 1; });
