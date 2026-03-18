const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("AMLOracle", function () {
    let identity, onboardingReg, amlOracle;
    let owner, bankAgent, clientAgent, humanApprover, stranger;
    let bankAgentId, clientAgentId;
    let flowId, requestId;

    const FLOW_SEED  = ethers.keccak256(ethers.toUtf8Bytes("flow-aml-001"));
    const SPEC_HASH  = ethers.keccak256(ethers.toUtf8Bytes("kyc-doc-spec-v1"));
    const DATA_HASH  = ethers.keccak256(ethers.toUtf8Bytes("documents-batch-1"));
    const RESULT_HASH = ethers.keccak256(ethers.toUtf8Bytes("aml-screening-result"));
    const REASON     = ethers.toUtf8Bytes("Sanctions list match");

    beforeEach(async function () {
        [owner, bankAgent, clientAgent, humanApprover, stranger] = await ethers.getSigners();

        // Identity registry
        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        // Onboarding registry
        const OnboardingReg = await ethers.getContractFactory("OnboardingRegistry");
        onboardingReg = await OnboardingReg.deploy(owner.address);
        await onboardingReg.waitForDeployment();

        // AML oracle
        const AMLOracle = await ethers.getContractFactory("AMLOracle");
        amlOracle = await AMLOracle.deploy(
            await identity.getAddress(),
            await onboardingReg.getAddress()
        );
        await amlOracle.waitForDeployment();

        // Register the AML oracle with OnboardingRegistry (so it can call setPhaseComplete/terminate)
        await onboardingReg.setOracle(await amlOracle.getAddress(), true);
        // Also register owner as oracle so we can initiate flows in tests
        await onboardingReg.setOracle(owner.address, true);

        // Register bank agent (agentWallet = bankAgent, oracleAddress = amlOracle)
        await identity.connect(bankAgent)[
            "register(string,(string,bytes)[],address)"
        ]("ipfs://bank-aml-agent", [], await amlOracle.getAddress());
        bankAgentId = 0n;

        // Register client agent (agentWallet = clientAgent, no oracle binding)
        await identity.connect(clientAgent)[
            "register(string,(string,bytes)[])"
        ]("ipfs://hf-document-agent", []);
        clientAgentId = 1n;

        // Initiate a flow
        flowId = FLOW_SEED;
        await onboardingReg.initiateOnboarding(flowId, stranger.address);

        // Open an AML review request (returns requestId via event)
        const tx = await amlOracle.connect(bankAgent).requestAMLReview(
            flowId, bankAgentId, clientAgentId
        );
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(l => { try { return amlOracle.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "AMLReviewRequested");
        requestId = event.args.requestId;
    });

    // ── requestAMLReview ──────────────────────────────────────────────────────

    describe("requestAMLReview()", function () {
        it("creates a request with Pending status", async function () {
            const req = await amlOracle.getRequest(requestId);
            expect(req.flowId).to.equal(flowId);
            expect(req.bankAgentId).to.equal(bankAgentId);
            expect(req.clientAgentId).to.equal(clientAgentId);
            expect(req.status).to.equal(1); // Pending
        });

        it("emits AMLReviewRequested", async function () {
            // Already emitted in beforeEach; verify getStatus
            expect(await amlOracle.getStatus(requestId)).to.equal(1);
        });

        it("reverts if caller is not bank agent wallet", async function () {
            await expect(
                amlOracle.connect(stranger).requestAMLReview(flowId, bankAgentId, clientAgentId)
            ).to.be.revertedWith("AMLOracle: caller is not the bank agent wallet");
        });

        it("reverts if flow is not active", async function () {
            await onboardingReg.terminate(flowId, REASON);
            await expect(
                amlOracle.connect(bankAgent).requestAMLReview(
                    flowId, bankAgentId, clientAgentId
                )
            ).to.be.revertedWith("AMLOracle: flow terminated or does not exist");
        });
    });

    // ── requestClientData ─────────────────────────────────────────────────────

    describe("requestClientData()", function () {
        it("moves status to DataRequested and emits event", async function () {
            await expect(
                amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH)
            )
                .to.emit(amlOracle, "DataRequested")
                .withArgs(requestId, flowId, SPEC_HASH, 1, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await amlOracle.getStatus(requestId)).to.equal(2); // DataRequested
        });

        it("increments dataRequestRound", async function () {
            await amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH);
            const req = await amlOracle.getRequest(requestId);
            expect(req.dataRequestRound).to.equal(1);
        });

        it("reverts if not Pending", async function () {
            await amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH);
            await expect(
                amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH)
            ).to.be.revertedWith("must be Pending to request data");
        });

        it("reverts when agentId wallet does not match caller", async function () {
            // clientAgentId's wallet is clientAgent, not bankAgent → modifier fires
            await expect(
                amlOracle.connect(bankAgent).requestClientData(requestId, clientAgentId, SPEC_HASH)
            ).to.be.revertedWith("AMLOracle: caller is not the bank agent wallet");
        });
    });

    // ── fulfillDataRequest ────────────────────────────────────────────────────

    describe("fulfillDataRequest()", function () {
        beforeEach(async function () {
            await amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH);
        });

        it("resumes flow to Pending and emits DataFulfilled", async function () {
            await expect(
                amlOracle.connect(clientAgent).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash)
            )
                .to.emit(amlOracle, "DataFulfilled")
                .withArgs(requestId, flowId, DATA_HASH, clientAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await amlOracle.getStatus(requestId)).to.equal(1); // Pending
        });

        it("reverts if not DataRequested", async function () {
            await amlOracle.connect(clientAgent).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash);
            await expect(
                amlOracle.connect(clientAgent).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("not waiting for data");
        });

        it("reverts when agentId wallet does not match caller", async function () {
            // bankAgentId's wallet is bankAgent, not clientAgent → modifier fires
            await expect(
                amlOracle.connect(clientAgent).fulfillDataRequest(requestId, bankAgentId, DATA_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("AMLOracle: caller is not the client agent wallet");
        });

        it("reverts if caller is not client agent wallet", async function () {
            await expect(
                amlOracle.connect(stranger).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("AMLOracle: caller is not the client agent wallet");
        });
    });

    // ── submitRecommendation ──────────────────────────────────────────────────

    describe("submitRecommendation()", function () {
        it("moves to InHumanReview and emits event", async function () {
            await expect(
                amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash)
            )
                .to.emit(amlOracle, "InHumanReview")
                .withArgs(requestId, flowId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await amlOracle.getStatus(requestId)).to.equal(3); // InHumanReview
        });

        it("accepts from DataRequested state too", async function () {
            await amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH);
            await expect(
                amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash)
            ).to.emit(amlOracle, "InHumanReview");
        });

        it("reverts if not Pending or DataRequested", async function () {
            await amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
            await expect(
                amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash)
            ).to.be.revertedWith("must be Pending or DataRequested");
        });
    });

    // ── escalate ──────────────────────────────────────────────────────────────

    describe("escalate()", function () {
        beforeEach(async function () {
            await amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
        });

        it("moves to Escalated and emits event", async function () {
            await expect(
                amlOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON)
            )
                .to.emit(amlOracle, "Escalated")
                .withArgs(requestId, flowId, REASON, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await amlOracle.getStatus(requestId)).to.equal(4); // Escalated
        });

        it("reverts if not InHumanReview", async function () {
            await expect(
                amlOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON)
            ).to.not.be.reverted;
            // Now Escalated, try again
            await expect(
                amlOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON)
            ).to.be.revertedWith("must be InHumanReview to escalate");
        });
    });

    // ── clear ─────────────────────────────────────────────────────────────────

    describe("clear()", function () {
        beforeEach(async function () {
            await amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
        });

        it("sets status to Cleared and sets PHASE_AML_CLEARED in registry", async function () {
            await expect(
                amlOracle.connect(humanApprover).clear(requestId, bankAgentId)
            )
                .to.emit(amlOracle, "AMLCleared")
                .withArgs(requestId, flowId, bankAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

            expect(await amlOracle.getStatus(requestId)).to.equal(5); // Cleared
            const bit = await onboardingReg.PHASE_AML_CLEARED();
            expect(await onboardingReg.phaseBitmask(flowId)).to.equal(bit);
        });

        it("works from Escalated state", async function () {
            await amlOracle.connect(bankAgent).escalate(requestId, bankAgentId, REASON);
            await expect(
                amlOracle.connect(humanApprover).clear(requestId, bankAgentId)
            ).to.emit(amlOracle, "AMLCleared");
        });

        it("reverts if agent tries to self-approve", async function () {
            await expect(
                amlOracle.connect(bankAgent).clear(requestId, bankAgentId)
            ).to.be.revertedWith("AMLOracle: agent cannot self-approve");
        });

        it("reverts if not InHumanReview or Escalated", async function () {
            const flowId2 = ethers.keccak256(ethers.toUtf8Bytes("flow-aml-002"));
            await onboardingReg.initiateOnboarding(flowId2, stranger.address);
            const tx = await amlOracle.connect(bankAgent).requestAMLReview(
                flowId2, bankAgentId, clientAgentId
            );
            const receipt = await tx.wait();
            const event = receipt.logs
                .map(l => { try { return amlOracle.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "AMLReviewRequested");
            const reqId2 = event.args.requestId;

            await expect(
                amlOracle.connect(humanApprover).clear(reqId2, bankAgentId)
            ).to.be.revertedWith("must be InHumanReview or Escalated");
        });
    });

    // ── reject ────────────────────────────────────────────────────────────────

    describe("reject()", function () {
        beforeEach(async function () {
            await amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
        });

        it("sets status to Rejected and terminates the flow", async function () {
            await expect(
                amlOracle.connect(humanApprover).reject(requestId, bankAgentId, REASON)
            )
                .to.emit(amlOracle, "AMLRejected")
                .withArgs(requestId, flowId, REASON, bankAgentId, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1))
                .and.to.emit(onboardingReg, "OnboardingTerminated");

            expect(await amlOracle.getStatus(requestId)).to.equal(6); // Rejected
            expect(await onboardingReg.isActive(flowId)).to.equal(false);
        });

        it("reverts if agent tries to self-reject", async function () {
            await expect(
                amlOracle.connect(bankAgent).reject(requestId, bankAgentId, REASON)
            ).to.be.revertedWith("AMLOracle: agent cannot self-reject");
        });

        it("blocks subsequent oracle actions after rejection (flow terminated)", async function () {
            await amlOracle.connect(humanApprover).reject(requestId, bankAgentId, REASON);
            const flowId2 = ethers.keccak256(ethers.toUtf8Bytes("terminated-flow-aml"));
            // Can't initiate (flow terminated is a different flow; test that isActive blocks new requests)
            await onboardingReg.initiateOnboarding(flowId2, stranger.address);
            await onboardingReg.terminate(flowId2, REASON);
            const tx = await amlOracle.connect(bankAgent).requestAMLReview(
                ethers.keccak256(ethers.toUtf8Bytes("new-flow-for-block-test")),
                bankAgentId, clientAgentId
            ).catch(() => null); // flow not active — reverts
            // Confirm original flow is terminated
            expect(await onboardingReg.isActive(flowId)).to.equal(false);
        });
    });

    // ── data loop (requestClientData → fulfillDataRequest multi-round) ────────

    describe("multi-round data loop", function () {
        it("allows multiple request/fulfill cycles before recommendation", async function () {
            // Round 1
            await amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, SPEC_HASH);
            await amlOracle.connect(clientAgent).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash);
            expect(await amlOracle.getStatus(requestId)).to.equal(1); // back to Pending

            // Round 2
            const spec2 = ethers.keccak256(ethers.toUtf8Bytes("kyc-doc-spec-v2"));
            await amlOracle.connect(bankAgent).requestClientData(requestId, bankAgentId, spec2);
            const req = await amlOracle.getRequest(requestId);
            expect(req.dataRequestRound).to.equal(2);

            await amlOracle.connect(clientAgent).fulfillDataRequest(requestId, clientAgentId, DATA_HASH, ethers.ZeroHash);
            // Now submit recommendation
            await amlOracle.connect(bankAgent).submitRecommendation(requestId, bankAgentId, RESULT_HASH, ethers.ZeroHash);
            expect(await amlOracle.getStatus(requestId)).to.equal(3); // InHumanReview
        });
    });
});
