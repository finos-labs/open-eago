const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("CreditRiskOracle", function () {
    let identity, onboardingReg, creditOracle;
    let owner, bankAgent, clientAgent, humanApprover, stranger;
    let bankAgentId, clientAgentId;
    let flowId, requestId;

    const FLOW_SEED    = ethers.keccak256(ethers.toUtf8Bytes("flow-credit-001"));
    const SPEC_HASH    = ethers.keccak256(ethers.toUtf8Bytes("financial-statements-spec"));
    const DATA_HASH    = ethers.keccak256(ethers.toUtf8Bytes("financial-statements-batch"));
    const TERMS_HASH   = ethers.keccak256(ethers.toUtf8Bytes("credit-terms-v1"));
    const COUNTER_HASH = ethers.keccak256(ethers.toUtf8Bytes("credit-counter-v1"));
    const AGREED_HASH  = ethers.keccak256(ethers.toUtf8Bytes("credit-terms-agreed"));
    const RESULT_HASH  = ethers.keccak256(ethers.toUtf8Bytes("credit-assessment-result"));
    const REASON       = ethers.toUtf8Bytes("Credit limit unacceptable");

    async function openRequest(fId) {
        const tx = await creditOracle.connect(bankAgent).requestCreditReview(
            fId, bankAgentId, clientAgentId
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(l => { try { return creditOracle.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "CreditReviewRequested");
        return event.args.requestId;
    }

    beforeEach(async function () {
        [owner, bankAgent, clientAgent, humanApprover, stranger] = await ethers.getSigners();

        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        const OnboardingReg = await ethers.getContractFactory("OnboardingRegistry");
        onboardingReg = await OnboardingReg.deploy(owner.address);
        await onboardingReg.waitForDeployment();

        const CreditOracle = await ethers.getContractFactory("CreditRiskOracle");
        creditOracle = await CreditOracle.deploy(
            await identity.getAddress(),
            await onboardingReg.getAddress()
        );
        await creditOracle.waitForDeployment();

        await onboardingReg.setOracle(await creditOracle.getAddress(), true);
        await onboardingReg.setOracle(owner.address, true);

        await identity.connect(bankAgent)[
            "register(string,(string,bytes)[],address)"
        ]("ipfs://bank-credit-agent", [], await creditOracle.getAddress());
        bankAgentId = 0n;

        await identity.connect(clientAgent)[
            "register(string,(string,bytes)[])"
        ]("ipfs://hf-credit-negotiator", []);
        clientAgentId = 1n;

        flowId = FLOW_SEED;
        await onboardingReg.initiateOnboarding(flowId, stranger.address);
        requestId = await openRequest(flowId);
    });

    // ── requestCreditReview ───────────────────────────────────────────────────

    describe("requestCreditReview()", function () {
        it("creates a request with Pending status", async function () {
            const req = await creditOracle.getRequest(requestId);
            expect(req.status).to.equal(1); // Pending
            expect(req.flowId).to.equal(flowId);
            expect(req.bankAgentId).to.equal(bankAgentId);
            expect(req.clientAgentId).to.equal(clientAgentId);
        });

        it("reverts for non-bank agent caller", async function () {
            await expect(
                creditOracle.connect(stranger).requestCreditReview(flowId, bankAgentId, clientAgentId)
            ).to.be.revertedWith("CreditRiskOracle: caller is not the bank agent wallet");
        });

        it("reverts if flow terminated", async function () {
            await onboardingReg.terminate(flowId, REASON);
            const flowId2 = ethers.keccak256(ethers.toUtf8Bytes("flow-credit-002"));
            await expect(
                creditOracle.connect(bankAgent).requestCreditReview(flowId, bankAgentId, clientAgentId)
            ).to.be.revertedWith("CreditRiskOracle: flow terminated or does not exist");
        });
    });

    // ── requestClientData / fulfillDataRequest ────────────────────────────────

    describe("data request loop", function () {
        it("DataRequested → fulfill → Pending cycle", async function () {
            await expect(
                creditOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH)
            ).to.emit(creditOracle, "DataRequested").withArgs(requestId, flowId, SPEC_HASH, 1, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await creditOracle.getStatus(requestId)).to.equal(2); // DataRequested

            await expect(
                creditOracle.connect(clientAgent).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash)
            ).to.emit(creditOracle, "DataFulfilled");

            expect(await creditOracle.getStatus(requestId)).to.equal(1); // Pending
        });

        it("reverts fulfillDataRequest if wrong client agent", async function () {
            await creditOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH);
            await expect(
                creditOracle.connect(stranger).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("CreditRiskOracle: caller is not the client agent wallet");
        });
    });

    // ── proposeTerms ──────────────────────────────────────────────────────────

    describe("proposeTerms()", function () {
        it("moves to Negotiating and emits TermsProposed", async function () {
            await expect(
                creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash)
            )
                .to.emit(creditOracle, "TermsProposed")
                .withArgs(requestId, flowId, TERMS_HASH, 1, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await creditOracle.getStatus(requestId)).to.equal(3); // Negotiating
            const req = await creditOracle.getRequest(requestId);
            expect(req.negotiationRound).to.equal(1);
            expect(req.currentTermsHash).to.equal(TERMS_HASH);
        });

        it("reverts if not Pending", async function () {
            await creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash);
            await expect(
                creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("must be Pending to propose terms");
        });
    });

    // ── submitCounterProposal ─────────────────────────────────────────────────

    describe("submitCounterProposal()", function () {
        beforeEach(async function () {
            await creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash);
        });

        it("resumes to Pending and emits CounterProposed", async function () {
            await expect(
                creditOracle.connect(clientAgent).submitCounterProposal(requestId, clientAgentId, COUNTER_HASH, ethers.ZeroHash)
            )
                .to.emit(creditOracle, "CounterProposed")
                .withArgs(requestId, flowId, COUNTER_HASH, clientAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await creditOracle.getStatus(requestId)).to.equal(1); // Pending
            const req = await creditOracle.getRequest(requestId);
            expect(req.currentTermsHash).to.equal(COUNTER_HASH);
        });

        it("reverts if not Negotiating", async function () {
            await creditOracle.connect(clientAgent).submitCounterProposal(requestId, clientAgentId, COUNTER_HASH, ethers.ZeroHash);
            await expect(
                creditOracle.connect(clientAgent).submitCounterProposal(requestId, clientAgentId, COUNTER_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("not in negotiation");
        });

        it("reverts for wrong client agent", async function () {
            await expect(
                creditOracle.connect(stranger).submitCounterProposal(requestId, clientAgentId, COUNTER_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("CreditRiskOracle: caller is not the client agent wallet");
        });
    });

    // ── acceptTerms ───────────────────────────────────────────────────────────

    describe("acceptTerms()", function () {
        beforeEach(async function () {
            await creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash);
        });

        it("resumes to Pending and emits TermsAgreed", async function () {
            await expect(
                creditOracle.connect(bankAgent).acceptTerms(requestId, bankAgentId, AGREED_HASH, ethers.ZeroHash)
            )
                .to.emit(creditOracle, "TermsAgreed")
                .withArgs(requestId, flowId, AGREED_HASH, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await creditOracle.getStatus(requestId)).to.equal(1); // Pending
        });

        it("reverts if not Negotiating", async function () {
            await creditOracle.connect(bankAgent).acceptTerms(requestId, bankAgentId, AGREED_HASH, ethers.ZeroHash);
            await expect(
                creditOracle.connect(bankAgent).acceptTerms(requestId, bankAgentId, AGREED_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("must be Negotiating to accept");
        });
    });

    // ── submitRecommendation ──────────────────────────────────────────────────

    describe("submitRecommendation()", function () {
        it("moves to InHumanReview", async function () {
            await creditOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
            expect(await creditOracle.getStatus(requestId)).to.equal(4); // InHumanReview
        });
    });

    // ── escalate ──────────────────────────────────────────────────────────────

    describe("escalate()", function () {
        beforeEach(async function () {
            await creditOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
        });

        it("moves to Escalated", async function () {
            await expect(
                creditOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON)
            ).to.emit(creditOracle, "Escalated");
            expect(await creditOracle.getStatus(requestId)).to.equal(5); // Escalated
        });
    });

    // ── approve ───────────────────────────────────────────────────────────────

    describe("approve()", function () {
        beforeEach(async function () {
            await creditOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
        });

        it("clears credit and sets PHASE_CREDIT_APPROVED in registry", async function () {
            await expect(
                creditOracle.connect(humanApprover).approve(requestId, bankAgentId)
            )
                .to.emit(creditOracle, "CreditApproved")
                .withArgs(requestId, flowId, bankAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await creditOracle.getStatus(requestId)).to.equal(6); // Approved
            const bit = await onboardingReg.PHASE_CREDIT_APPROVED();
            expect(await onboardingReg.phaseBitmask(flowId)).to.equal(bit);
        });

        it("works from Escalated state", async function () {
            await creditOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON);
            await expect(
                creditOracle.connect(humanApprover).approve(requestId, bankAgentId)
            ).to.emit(creditOracle, "CreditApproved");
        });

        it("reverts on self-approval by agent", async function () {
            await expect(
                creditOracle.connect(bankAgent).approve(requestId, bankAgentId)
            ).to.be.revertedWith("CreditRiskOracle: agent cannot self-approve");
        });
    });

    // ── reject ────────────────────────────────────────────────────────────────

    describe("reject()", function () {
        beforeEach(async function () {
            await creditOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
        });

        it("rejects and terminates flow", async function () {
            await expect(
                creditOracle.connect(humanApprover).reject(requestId, bankAgentId, REASON)
            )
                .to.emit(creditOracle, "CreditRejected")
                .and.to.emit(onboardingReg, "OnboardingTerminated");

            expect(await creditOracle.getStatus(requestId)).to.equal(7); // Rejected
            expect(await onboardingReg.isActive(flowId)).to.equal(false);
        });

        it("reverts on self-rejection by agent", async function () {
            await expect(
                creditOracle.connect(bankAgent).reject(requestId, bankAgentId, REASON)
            ).to.be.revertedWith("CreditRiskOracle: agent cannot self-reject");
        });
    });

    // ── full negotiation cycle ────────────────────────────────────────────────

    describe("full negotiation cycle", function () {
        it("proposeTerms → counter → proposeTerms → acceptTerms → submitRecommendation → approve", async function () {
            // Bank proposes
            await creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash);
            // HF counters
            await creditOracle.connect(clientAgent).submitCounterProposal(requestId, clientAgentId, COUNTER_HASH, ethers.ZeroHash);
            // Bank proposes revised
            await creditOracle.connect(bankAgent).proposeTerms(requestId, bankAgentId, TERMS_HASH, ethers.ZeroHash);
            const req = await creditOracle.getRequest(requestId);
            expect(req.negotiationRound).to.equal(2);
            // Bank accepts
            await creditOracle.connect(bankAgent).acceptTerms(requestId, bankAgentId, AGREED_HASH, ethers.ZeroHash);
            // Submit recommendation
            await creditOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
            // Human approves
            await creditOracle.connect(humanApprover).approve(requestId, bankAgentId);
            expect(await creditOracle.getStatus(requestId)).to.equal(6); // Approved
        });
    });
});
