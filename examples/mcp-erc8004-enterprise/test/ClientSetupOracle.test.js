const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("ClientSetupOracle", function () {
    let identity, onboardingReg;
    let amlOracle, creditOracle, legalOracle, setupOracle;
    let owner, setupAgent, bankAgent, clientAgent, bankApprover, clientApprover, stranger;
    let setupAgentId;
    let flowId;

    const FLOW_SEED        = ethers.keccak256(ethers.toUtf8Bytes("flow-setup-001"));
    const ENTITY_SPEC_HASH = ethers.keccak256(ethers.toUtf8Bytes("entity-spec-v1"));
    const ACCOUNT_SPEC     = ethers.keccak256(ethers.toUtf8Bytes("account-config-v1"));
    const PRODUCT_SPEC     = ethers.keccak256(ethers.toUtf8Bytes("product-config-v1"));
    const RESULT_HASH      = ethers.keccak256(ethers.toUtf8Bytes("review-result"));
    const REASON           = ethers.toUtf8Bytes("Test termination");

    // Complete all three reviews so setup phases can proceed
    async function completeAllReviews(fId) {
        // AML
        const amlTx = await amlOracle.connect(bankAgent).requestAMLReview(fId, 0n, 2n);
        const amlReceipt = await amlTx.wait();
        const amlReqId = amlOracle.interface.parseLog(
            amlReceipt.logs.find(l => { try { return amlOracle.interface.parseLog(l).name === "AMLReviewRequested"; } catch { return false; } })
        ).args.requestId;
        await amlOracle.connect(bankAgent).submitRecommendation(amlReqId, 0n, RESULT_HASH, ethers.ZeroHash);
        await amlOracle.connect(bankApprover).clear(amlReqId, 0n);

        // Credit
        const crTx = await creditOracle.connect(bankAgent).requestCreditReview(fId, 1n, 2n);
        const crReceipt = await crTx.wait();
        const crReqId = creditOracle.interface.parseLog(
            crReceipt.logs.find(l => { try { return creditOracle.interface.parseLog(l).name === "CreditReviewRequested"; } catch { return false; } })
        ).args.requestId;
        await creditOracle.connect(bankAgent).submitRecommendation(crReqId, 1n, RESULT_HASH, ethers.ZeroHash);
        await creditOracle.connect(bankApprover).approve(crReqId, 1n);

        // Legal
        const lgTx = await legalOracle.connect(bankAgent).requestLegalReview(fId, 3n, 2n);
        const lgReceipt = await lgTx.wait();
        const lgReqId = legalOracle.interface.parseLog(
            lgReceipt.logs.find(l => { try { return legalOracle.interface.parseLog(l).name === "LegalReviewRequested"; } catch { return false; } })
        ).args.requestId;
        await legalOracle.connect(bankAgent).submitRecommendation(lgReqId, 3n, RESULT_HASH, ethers.ZeroHash);
        await legalOracle.connect(bankApprover).approveBankSide(lgReqId, 3n);
        await legalOracle.connect(clientApprover).approveClientSide(lgReqId, 2n);
        await legalOracle.connect(stranger).execute(lgReqId);
    }

    beforeEach(async function () {
        [owner, setupAgent, bankAgent, clientAgent, bankApprover, clientApprover, stranger] =
            await ethers.getSigners();

        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        const OnboardingReg = await ethers.getContractFactory("OnboardingRegistry");
        onboardingReg = await OnboardingReg.deploy(owner.address);
        await onboardingReg.waitForDeployment();

        // Deploy review oracles
        const AMLOracle = await ethers.getContractFactory("AMLOracle");
        amlOracle = await AMLOracle.deploy(await identity.getAddress(), await onboardingReg.getAddress());
        await amlOracle.waitForDeployment();

        const CreditOracle = await ethers.getContractFactory("CreditRiskOracle");
        creditOracle = await CreditOracle.deploy(await identity.getAddress(), await onboardingReg.getAddress());
        await creditOracle.waitForDeployment();

        const LegalOracle = await ethers.getContractFactory("LegalOracle");
        legalOracle = await LegalOracle.deploy(await identity.getAddress(), await onboardingReg.getAddress());
        await legalOracle.waitForDeployment();

        // Deploy setup oracle
        const SetupOracle = await ethers.getContractFactory("ClientSetupOracle");
        setupOracle = await SetupOracle.deploy(await identity.getAddress(), await onboardingReg.getAddress());
        await setupOracle.waitForDeployment();

        // Register all oracles + owner
        for (const addr of [
            await amlOracle.getAddress(),
            await creditOracle.getAddress(),
            await legalOracle.getAddress(),
            await setupOracle.getAddress(),
            owner.address,
        ]) {
            await onboardingReg.setOracle(addr, true);
        }

        // Register agents:
        // agentId 0: bankAgent → AMLOracle
        await identity.connect(bankAgent)["register(string,(string,bytes)[],address)"](
            "ipfs://bank-aml", [], await amlOracle.getAddress()
        );
        // agentId 1: bankAgent → CreditRiskOracle  (second register from same signer mints new token)
        await identity.connect(bankAgent)["register(string,(string,bytes)[],address)"](
            "ipfs://bank-credit", [], await creditOracle.getAddress()
        );
        // agentId 2: clientAgent → no oracle (document/legal agent)
        await identity.connect(clientAgent)["register(string,(string,bytes)[])"](
            "ipfs://hf-agent", []
        );
        // agentId 3: bankAgent → LegalOracle
        await identity.connect(bankAgent)["register(string,(string,bytes)[],address)"](
            "ipfs://bank-legal", [], await legalOracle.getAddress()
        );
        // agentId 4: setupAgent → ClientSetupOracle
        await identity.connect(setupAgent)["register(string,(string,bytes)[],address)"](
            "ipfs://bank-setup", [], await setupOracle.getAddress()
        );
        setupAgentId = 4n;

        // Initiate flow
        flowId = FLOW_SEED;
        await onboardingReg.initiateOnboarding(flowId, stranger.address);
    });

    // ── setupLegalEntity ──────────────────────────────────────────────────────

    describe("setupLegalEntity()", function () {
        it("reverts if reviews are not complete", async function () {
            await expect(
                setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: reviews not complete");
        });

        it("succeeds after all reviews complete and sets PHASE_ENTITY_SETUP_DONE", async function () {
            await completeAllReviews(flowId);

            await expect(
                setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash)
            )
                .to.emit(setupOracle, "LegalEntitySetupStarted").withArgs(flowId, setupAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1))
                .and.to.emit(setupOracle, "LegalEntitySetupComplete");

            const entityBit = await onboardingReg.PHASE_ENTITY_SETUP_DONE();
            expect(await onboardingReg.phaseBitmask(flowId) & entityBit).to.equal(entityBit);
        });

        it("reverts on duplicate call", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);
            await expect(
                setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: legal entity already set up");
        });

        it("reverts for non-setup-agent caller", async function () {
            await completeAllReviews(flowId);
            await expect(
                setupOracle.connect(stranger).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: caller is not the bank agent wallet");
        });

        it("reverts if flow terminated", async function () {
            await onboardingReg.terminate(flowId, REASON);
            await expect(
                setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: flow terminated or does not exist");
        });
    });

    // ── setupAccount ──────────────────────────────────────────────────────────

    describe("setupAccount()", function () {
        it("reverts if legal entity setup not done", async function () {
            await completeAllReviews(flowId);
            await expect(
                setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: legal entity setup not complete");
        });

        it("succeeds after entity setup and sets PHASE_ACCOUNT_SETUP_DONE", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);

            await expect(
                setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash)
            )
                .to.emit(setupOracle, "AccountSetupComplete");

            const accountBit = await onboardingReg.PHASE_ACCOUNT_SETUP_DONE();
            expect(await onboardingReg.phaseBitmask(flowId) & accountBit).to.equal(accountBit);
        });

        it("reverts on duplicate call", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);
            await setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash);
            await expect(
                setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: account already set up");
        });
    });

    // ── setupProducts ─────────────────────────────────────────────────────────

    describe("setupProducts()", function () {
        it("reverts if account setup not done", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);
            await expect(
                setupOracle.connect(setupAgent).setupProducts(flowId, setupAgentId, PRODUCT_SPEC, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: account setup not complete");
        });

        it("completes onboarding and emits ReadyToTransact", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);
            await setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash);

            await expect(
                setupOracle.connect(setupAgent).setupProducts(flowId, setupAgentId, PRODUCT_SPEC, ethers.ZeroHash)
            )
                .to.emit(setupOracle, "ProductSetupComplete")
                .and.to.emit(onboardingReg, "ReadyToTransact").withArgs(flowId, stranger.address, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await onboardingReg.phaseBitmask(flowId)).to.equal(await onboardingReg.ALL_PHASES_DONE());
        });

        it("reverts on duplicate call", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);
            await setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash);
            await setupOracle.connect(setupAgent).setupProducts(flowId, setupAgentId, PRODUCT_SPEC, ethers.ZeroHash);
            await expect(
                setupOracle.connect(setupAgent).setupProducts(flowId, setupAgentId, PRODUCT_SPEC, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: products already set up");
        });
    });

    // ── sequential gating enforcement ─────────────────────────────────────────

    describe("sequential gating", function () {
        it("cannot skip to account setup before entity setup", async function () {
            await completeAllReviews(flowId);
            await expect(
                setupOracle.connect(setupAgent).setupAccount(flowId, setupAgentId, ACCOUNT_SPEC, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: legal entity setup not complete");
        });

        it("cannot skip to product setup before account setup", async function () {
            await completeAllReviews(flowId);
            await setupOracle.connect(setupAgent).setupLegalEntity(flowId, setupAgentId, ENTITY_SPEC_HASH, ethers.ZeroHash);
            await expect(
                setupOracle.connect(setupAgent).setupProducts(flowId, setupAgentId, PRODUCT_SPEC, ethers.ZeroHash)
            ).to.be.revertedWith("ClientSetupOracle: account setup not complete");
        });
    });
});
