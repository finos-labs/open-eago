const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("LegalOracle", function () {
    let identity, onboardingReg, legalOracle;
    let owner, bankAgent, clientAgent, bankApprover, clientApprover, stranger;
    let bankAgentId, clientAgentId;
    let flowId, requestId;

    const FLOW_SEED     = ethers.keccak256(ethers.toUtf8Bytes("flow-legal-001"));
    const DRAFT_HASH_1  = ethers.keccak256(ethers.toUtf8Bytes("contract-draft-round-1"));
    const MARKUP_HASH_1 = ethers.keccak256(ethers.toUtf8Bytes("contract-markup-round-1"));
    const DRAFT_HASH_2  = ethers.keccak256(ethers.toUtf8Bytes("contract-draft-round-2"));
    const FINAL_HASH    = ethers.keccak256(ethers.toUtf8Bytes("contract-final"));
    const REASON        = ethers.toUtf8Bytes("Indemnity clause unacceptable");

    async function openRequest(fId) {
        const tx = await legalOracle.connect(bankAgent).requestLegalReview(
            fId, bankAgentId, clientAgentId
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(l => { try { return legalOracle.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "LegalReviewRequested");
        return event.args.requestId;
    }

    beforeEach(async function () {
        [owner, bankAgent, clientAgent, bankApprover, clientApprover, stranger] = await ethers.getSigners();

        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        const OnboardingReg = await ethers.getContractFactory("OnboardingRegistry");
        onboardingReg = await OnboardingReg.deploy(owner.address);
        await onboardingReg.waitForDeployment();

        const LegalOracle = await ethers.getContractFactory("LegalOracle");
        legalOracle = await LegalOracle.deploy(
            await identity.getAddress(),
            await onboardingReg.getAddress()
        );
        await legalOracle.waitForDeployment();

        await onboardingReg.setOracle(await legalOracle.getAddress(), true);
        await onboardingReg.setOracle(owner.address, true);

        await identity.connect(bankAgent)[
            "register(string,(string,bytes)[],address)"
        ]("ipfs://bank-legal-agent", [], await legalOracle.getAddress());
        bankAgentId = 0n;

        await identity.connect(clientAgent)[
            "register(string,(string,bytes)[])"
        ]("ipfs://hf-legal-agent", []);
        clientAgentId = 1n;

        flowId = FLOW_SEED;
        await onboardingReg.initiateOnboarding(flowId, stranger.address);
        requestId = await openRequest(flowId);
    });

    // ── requestLegalReview ────────────────────────────────────────────────────

    describe("requestLegalReview()", function () {
        it("creates a request with Pending status", async function () {
            const req = await legalOracle.getRequest(requestId);
            expect(req.status).to.equal(1); // Pending
            expect(req.roundNumber).to.equal(0);
            expect(req.bankApproved).to.equal(false);
            expect(req.clientApproved).to.equal(false);
        });

        it("reverts for non-bank-agent caller", async function () {
            await expect(
                legalOracle.connect(stranger).requestLegalReview(flowId, bankAgentId, clientAgentId)
            ).to.be.revertedWith("LegalOracle: caller is not the bank agent wallet");
        });

        it("reverts if flow terminated", async function () {
            await onboardingReg.terminate(flowId, REASON);
            await expect(
                legalOracle.connect(bankAgent).requestLegalReview(flowId, bankAgentId, clientAgentId)
            ).to.be.revertedWith("LegalOracle: flow terminated or does not exist");
        });
    });

    // ── issueDraft ────────────────────────────────────────────────────────────

    describe("issueDraft()", function () {
        it("moves to DraftIssued, increments roundNumber, stores version hash", async function () {
            await expect(
                legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_1, ethers.ZeroHash)
            )
                .to.emit(legalOracle, "DraftIssued")
                .withArgs(requestId, flowId, DRAFT_HASH_1, 1, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await legalOracle.getStatus(requestId)).to.equal(2); // DraftIssued
            const req = await legalOracle.getRequest(requestId);
            expect(req.roundNumber).to.equal(1);
            expect(req.latestVersionHash).to.equal(DRAFT_HASH_1);
            expect(await legalOracle.getVersionHash(requestId, 1)).to.equal(DRAFT_HASH_1);
        });

        it("reverts if not Pending", async function () {
            await legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_1, ethers.ZeroHash);
            await expect(
                legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_1, ethers.ZeroHash)
            ).to.be.revertedWith("must be Pending to issue draft");
        });
    });

    // ── submitMarkup ──────────────────────────────────────────────────────────

    describe("submitMarkup()", function () {
        beforeEach(async function () {
            await legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_1, ethers.ZeroHash);
        });

        it("resumes to Pending and emits MarkupSubmitted", async function () {
            await expect(
                legalOracle.connect(clientAgent).submitMarkup(requestId, clientAgentId, MARKUP_HASH_1, ethers.ZeroHash)
            )
                .to.emit(legalOracle, "MarkupSubmitted")
                .withArgs(requestId, flowId, MARKUP_HASH_1, 1, clientAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await legalOracle.getStatus(requestId)).to.equal(1); // Pending
            const req = await legalOracle.getRequest(requestId);
            expect(req.latestVersionHash).to.equal(MARKUP_HASH_1);
        });

        it("reverts if no draft issued", async function () {
            // Submit markup → Pending; try to submit again
            await legalOracle.connect(clientAgent).submitMarkup(requestId, clientAgentId, MARKUP_HASH_1, ethers.ZeroHash);
            await expect(
                legalOracle.connect(clientAgent).submitMarkup(requestId, clientAgentId, MARKUP_HASH_1, ethers.ZeroHash)
            ).to.be.revertedWith("no draft to mark up");
        });

        it("reverts for wrong client agent", async function () {
            await expect(
                legalOracle.connect(stranger).submitMarkup(requestId, clientAgentId, MARKUP_HASH_1, ethers.ZeroHash)
            ).to.be.revertedWith("LegalOracle: caller is not the client agent wallet");
        });
    });

    // ── multi-round negotiation ───────────────────────────────────────────────

    describe("multi-round negotiation", function () {
        it("tracks round numbers and version hashes across rounds", async function () {
            // Round 1
            await legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_1, ethers.ZeroHash);
            expect(await legalOracle.getVersionHash(requestId, 1)).to.equal(DRAFT_HASH_1);

            await legalOracle.connect(clientAgent).submitMarkup(requestId, clientAgentId, MARKUP_HASH_1, ethers.ZeroHash);

            // Round 2
            await legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_2, ethers.ZeroHash);
            expect(await legalOracle.getVersionHash(requestId, 2)).to.equal(DRAFT_HASH_2);

            const req = await legalOracle.getRequest(requestId);
            expect(req.roundNumber).to.equal(2);

            // Original round 1 hash still accessible
            expect(await legalOracle.getVersionHash(requestId, 1)).to.equal(DRAFT_HASH_1);
        });
    });

    // ── submitRecommendation ──────────────────────────────────────────────────

    describe("submitRecommendation()", function () {
        it("moves to InHumanReview", async function () {
            await legalOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, FINAL_HASH, ethers.ZeroHash);
            expect(await legalOracle.getStatus(requestId)).to.equal(4); // InHumanReview
        });

        it("reverts if not Pending", async function () {
            await legalOracle.connect(bankAgent).issueDraft(requestId, bankAgentId, DRAFT_HASH_1, ethers.ZeroHash);
            await expect(
                legalOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, FINAL_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("must be Pending to submit recommendation");
        });
    });

    // ── escalate ──────────────────────────────────────────────────────────────

    describe("escalate()", function () {
        beforeEach(async function () {
            await legalOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, FINAL_HASH, ethers.ZeroHash);
        });

        it("moves to Escalated", async function () {
            await expect(
                legalOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON)
            ).to.emit(legalOracle, "Escalated");
            expect(await legalOracle.getStatus(requestId)).to.equal(5); // Escalated
        });
    });

    // ── bilateral approval ────────────────────────────────────────────────────

    describe("bilateral approval (approveBankSide / approveClientSide / execute)", function () {
        beforeEach(async function () {
            await legalOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, FINAL_HASH, ethers.ZeroHash);
        });

        it("bank approves → client approves → execute succeeds", async function () {
            await expect(
                legalOracle.connect(bankApprover).approveBankSide(requestId, bankAgentId)
            ).to.emit(legalOracle, "BankSideApproved").withArgs(requestId, flowId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            await expect(
                legalOracle.connect(clientApprover).approveClientSide(requestId, clientAgentId)
            ).to.emit(legalOracle, "ClientSideApproved");

            await expect(
                legalOracle.connect(stranger).execute(requestId)
            )
                .to.emit(legalOracle, "ContractExecuted")
                .withArgs(requestId, flowId, FINAL_HASH, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await legalOracle.getStatus(requestId)).to.equal(6); // Executed
            const bit = await onboardingReg.PHASE_LEGAL_EXECUTED();
            expect(await onboardingReg.phaseBitmask(flowId)).to.equal(bit);
        });

        it("execute reverts if only bank approved", async function () {
            await legalOracle.connect(bankApprover).approveBankSide(requestId, bankAgentId);
            await expect(
                legalOracle.connect(stranger).execute(requestId)
            ).to.be.revertedWith("LegalOracle: client side not yet approved");
        });

        it("execute reverts if only client approved", async function () {
            await legalOracle.connect(clientApprover).approveClientSide(requestId, clientAgentId);
            await expect(
                legalOracle.connect(stranger).execute(requestId)
            ).to.be.revertedWith("LegalOracle: bank side not yet approved");
        });

        it("execute reverts if neither side approved", async function () {
            await expect(
                legalOracle.connect(stranger).execute(requestId)
            ).to.be.revertedWith("LegalOracle: bank side not yet approved");
        });

        it("reverts double bank-side approval", async function () {
            await legalOracle.connect(bankApprover).approveBankSide(requestId, bankAgentId);
            await expect(
                legalOracle.connect(bankApprover).approveBankSide(requestId, bankAgentId)
            ).to.be.revertedWith("bank side already approved");
        });

        it("reverts double client-side approval", async function () {
            await legalOracle.connect(clientApprover).approveClientSide(requestId, clientAgentId);
            await expect(
                legalOracle.connect(clientApprover).approveClientSide(requestId, clientAgentId)
            ).to.be.revertedWith("client side already approved");
        });

        it("reverts self-approval by bank agent", async function () {
            await expect(
                legalOracle.connect(bankAgent).approveBankSide(requestId, bankAgentId)
            ).to.be.revertedWith("LegalOracle: agent cannot self-approve");
        });

        it("reverts self-approval by client agent", async function () {
            await expect(
                legalOracle.connect(clientAgent).approveClientSide(requestId, clientAgentId)
            ).to.be.revertedWith("LegalOracle: agent cannot self-approve");
        });

        it("bilateral approval works from Escalated state", async function () {
            await legalOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON);
            await legalOracle.connect(bankApprover).approveBankSide(requestId, bankAgentId);
            await legalOracle.connect(clientApprover).approveClientSide(requestId, clientAgentId);
            await expect(legalOracle.connect(stranger).execute(requestId))
                .to.emit(legalOracle, "ContractExecuted");
        });
    });

    // ── reject ────────────────────────────────────────────────────────────────

    describe("reject()", function () {
        beforeEach(async function () {
            await legalOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, FINAL_HASH, ethers.ZeroHash);
        });

        it("rejects and terminates flow", async function () {
            await expect(
                legalOracle.connect(bankApprover).reject(requestId, bankAgentId, REASON)
            )
                .to.emit(legalOracle, "LegalRejected")
                .and.to.emit(onboardingReg, "OnboardingTerminated");

            expect(await legalOracle.getStatus(requestId)).to.equal(7); // Rejected
            expect(await onboardingReg.isActive(flowId)).to.equal(false);
        });

        it("reverts self-rejection by agent", async function () {
            await expect(
                legalOracle.connect(bankAgent).reject(requestId, bankAgentId, REASON)
            ).to.be.revertedWith("LegalOracle: agent cannot self-reject");
        });
    });
});
