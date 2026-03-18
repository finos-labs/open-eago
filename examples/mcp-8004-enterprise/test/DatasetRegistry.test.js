const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("DatasetRegistry", function () {
    let datasetReg;
    let identity, traceLog, reviewerOracle, approverOracle;
    let owner, agent, requester, stranger;
    let agentId, approverAgentId;

    const CAP_REVIEW_CODE = ethers.id("review_code");
    const CAP_APPROVE_PR  = ethers.id("approve_pr");

    const HASH_A = ethers.keccak256(ethers.toUtf8Bytes("dataset-alpha-v1"));
    const HASH_B = ethers.keccak256(ethers.toUtf8Bytes("dataset-beta-v1"));
    const HASH_C = ethers.keccak256(ethers.toUtf8Bytes("dataset-gamma-v1"));
    const UNREGISTERED = ethers.keccak256(ethers.toUtf8Bytes("not-in-catalogue"));

    const PROMPT_HASH = ethers.ZeroHash; // passthrough (no PromptRegistry wired in these tests)

    beforeEach(async function () {
        [owner, agent, requester, stranger] = await ethers.getSigners();

        // Deploy DatasetRegistry
        const DatasetReg = await ethers.getContractFactory("DatasetRegistry");
        datasetReg = await DatasetReg.deploy();
        await datasetReg.waitForDeployment();

        // Deploy oracle infrastructure
        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        const TraceLog = await ethers.getContractFactory("ExecutionTraceLog");
        traceLog = await TraceLog.deploy();
        await traceLog.waitForDeployment();

        const MockOracle = await ethers.getContractFactory("MockOracle");
        reviewerOracle = await MockOracle.deploy(
            await identity.getAddress(),
            await traceLog.getAddress()
        );
        await reviewerOracle.waitForDeployment();

        approverOracle = await MockOracle.deploy(
            await identity.getAddress(),
            await traceLog.getAddress()
        );
        await approverOracle.waitForDeployment();

        // Register reviewer agent (agentId = 0)
        await identity.connect(agent)["register(string,(string,bytes)[],address)"](
            "ipfs://alice", [], await reviewerOracle.getAddress()
        );
        agentId = 0n;

        // Register approver agent (agentId = 1)
        await identity.connect(agent)["register(string,(string,bytes)[],address)"](
            "ipfs://dave", [], await approverOracle.getAddress()
        );
        approverAgentId = 1n;
    });

    // ── helpers ───────────────────────────────────────────────────────────────────

    async function openReviewRequest(prId, traceId = ethers.ZeroHash) {
        const tx = await reviewerOracle.connect(requester).requestReview(prId, traceId, "");
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(l => { try { return reviewerOracle.interface.parseLog(l); } catch { return null; } })
            .find(e => e?.name === "ReviewRequested");
        return { requestId: event.args.requestId, traceId: event.args.traceId };
    }

    async function openApprovalRequest(prId, traceId = ethers.ZeroHash) {
        const tx = await approverOracle.connect(requester).requestApproval({
            prId, traceId, reviewerAgent: "", message: "",
        });
        const receipt = await tx.wait();
        const event = receipt.logs
            .map(l => { try { return approverOracle.interface.parseLog(l); } catch { return null; } })
            .find(e => e?.name === "ApprovalRequested");
        return { requestId: event.args.requestId, traceId: event.args.traceId };
    }

    async function fulfillReview(requestId, prId, datasetHashes = []) {
        return reviewerOracle.connect(agent).fulfillReview(agentId, {
            requestId, prId,
            summaryJson: ethers.toUtf8Bytes("{}"),
            commentsJson: ethers.toUtf8Bytes("[]"),
            approved: true,
            promptHash: PROMPT_HASH,
            datasetHashes,
        });
    }

    async function fulfillApproval(requestId, prId, datasetHashes = []) {
        return approverOracle.connect(agent).fulfillApproval(approverAgentId, {
            requestId, prId,
            reasonJson: ethers.toUtf8Bytes("{}"),
            promptHash: PROMPT_HASH,
            datasetHashes,
        });
    }

    async function fulfillNeedsRevision(requestId, prId, datasetHashes = []) {
        return approverOracle.connect(agent).fulfillNeedsRevision(approverAgentId, {
            requestId, prId,
            reasonJson: ethers.toUtf8Bytes("{}"),
            unresolvedJson: ethers.toUtf8Bytes("[]"),
            promptHash: PROMPT_HASH,
            datasetHashes,
        });
    }

    async function fulfillRejection(requestId, prId, datasetHashes = []) {
        return approverOracle.connect(agent).fulfillRejection(approverAgentId, {
            requestId, prId,
            reasonJson: ethers.toUtf8Bytes("{}"),
            promptHash: PROMPT_HASH,
            datasetHashes,
        });
    }

    // ── constructor ───────────────────────────────────────────────────────────────

    describe("constructor", function () {
        it("sets owner to deployer", async function () {
            expect(await datasetReg.owner()).to.equal(owner.address);
        });
    });

    // ── registerDataset ───────────────────────────────────────────────────────────

    describe("registerDataset", function () {
        it("emits DatasetRegistered and marks as registered", async function () {
            await expect(datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "ipfs://dataset-alpha"))
                .to.emit(datasetReg, "DatasetRegistered")
                .withArgs(CAP_REVIEW_CODE, HASH_A, "ipfs://dataset-alpha");

            expect(await datasetReg.isRegistered(CAP_REVIEW_CODE, HASH_A)).to.be.true;
        });

        it("appears in getDatasets enumeration", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_B, "");
            const list = await datasetReg.getDatasets(CAP_REVIEW_CODE);
            expect(list).to.deep.equal([HASH_A, HASH_B]);
        });

        it("getDatasetInfo returns correct fields", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "ipfs://alpha");
            const [uri, registeredAt, globallyApproved] =
                await datasetReg.getDatasetInfo(CAP_REVIEW_CODE, HASH_A);
            expect(uri).to.equal("ipfs://alpha");
            expect(registeredAt).to.be.gt(0n);
            expect(globallyApproved).to.be.false;
        });

        it("reverts on zero contentHash", async function () {
            await expect(
                datasetReg.registerDataset(CAP_REVIEW_CODE, ethers.ZeroHash, "")
            ).to.be.revertedWith("zero contentHash");
        });

        it("reverts on duplicate registration", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await expect(
                datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "")
            ).to.be.revertedWith("already registered");
        });

        it("reverts from non-owner", async function () {
            await expect(
                datasetReg.connect(stranger).registerDataset(CAP_REVIEW_CODE, HASH_A, "")
            ).to.be.revertedWith("not owner");
        });

        it("same hash can be registered under different capabilities", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await expect(
                datasetReg.registerDataset(CAP_APPROVE_PR, HASH_A, "")
            ).to.not.be.reverted;
        });
    });

    // ── approveGlobally ───────────────────────────────────────────────────────────

    describe("approveGlobally", function () {
        beforeEach(async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
        });

        it("emits DatasetApproved and sets globallyApproved flag", async function () {
            await expect(datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_A))
                .to.emit(datasetReg, "DatasetApproved")
                .withArgs(CAP_REVIEW_CODE, HASH_A);

            const [, , globallyApproved] = await datasetReg.getDatasetInfo(CAP_REVIEW_CODE, HASH_A);
            expect(globallyApproved).to.be.true;
        });

        it("reverts if not registered", async function () {
            await expect(
                datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_B)
            ).to.be.revertedWith("not registered");
        });

        it("reverts from non-owner", async function () {
            await expect(
                datasetReg.connect(stranger).approveGlobally(CAP_REVIEW_CODE, HASH_A)
            ).to.be.revertedWith("not owner");
        });
    });

    // ── revokeGlobal ──────────────────────────────────────────────────────────────

    describe("revokeGlobal", function () {
        beforeEach(async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_B, "");
            await datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_A);
            await datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_B);
        });

        it("emits DatasetRevoked", async function () {
            await expect(datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_A))
                .to.emit(datasetReg, "DatasetRevoked")
                .withArgs(CAP_REVIEW_CODE, HASH_A);
        });

        it("revoked hash is no longer globally approved", async function () {
            await datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_A);
            const [, , globallyApproved] = await datasetReg.getDatasetInfo(CAP_REVIEW_CODE, HASH_A);
            expect(globallyApproved).to.be.false;
        });

        it("other approved hash still passes isApproved after one revoked", async function () {
            await datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_A);
            // HASH_B still approved; no flow policy → flowOk = true
            expect(await datasetReg.isApproved(ethers.ZeroHash, CAP_REVIEW_CODE, HASH_B)).to.be.true;
            // HASH_A now rejected
            expect(await datasetReg.isApproved(ethers.ZeroHash, CAP_REVIEW_CODE, HASH_A)).to.be.false;
        });

        it("revoking the last approved dataset restores opt-in (any hash passes)", async function () {
            await datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_A);
            await datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_B);
            // No approvals left → opt-in, everything passes
            expect(await datasetReg.isApproved(ethers.ZeroHash, CAP_REVIEW_CODE, UNREGISTERED)).to.be.true;
        });

        it("reverts if not currently approved", async function () {
            await datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_A); // first revoke OK
            await expect(
                datasetReg.revokeGlobal(CAP_REVIEW_CODE, HASH_A)   // second revoke fails
            ).to.be.revertedWith("not approved");
        });

        it("reverts from non-owner", async function () {
            await expect(
                datasetReg.connect(stranger).revokeGlobal(CAP_REVIEW_CODE, HASH_A)
            ).to.be.revertedWith("not owner");
        });
    });

    // ── approveForFlow ────────────────────────────────────────────────────────────

    describe("approveForFlow", function () {
        const traceId = ethers.id("trace-flow-1");

        beforeEach(async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_B, "");
        });

        it("emits FlowDatasetsApproved and sets flow policy", async function () {
            await expect(datasetReg.approveForFlow(traceId, [HASH_A, HASH_B]))
                .to.emit(datasetReg, "FlowDatasetsApproved")
                .withArgs(traceId, [HASH_A, HASH_B]);

            expect(await datasetReg.flowPolicyExists(traceId)).to.be.true;
        });

        it("getFlowDatasets returns the approved hashes", async function () {
            await datasetReg.approveForFlow(traceId, [HASH_A, HASH_B]);
            const list = await datasetReg.getFlowDatasets(traceId);
            expect(list).to.deep.equal([HASH_A, HASH_B]);
        });

        it("reverts on zero traceId", async function () {
            await expect(
                datasetReg.approveForFlow(ethers.ZeroHash, [HASH_A])
            ).to.be.revertedWith("zero traceId");
        });

        it("reverts on duplicate call for same traceId (immutable once set)", async function () {
            await datasetReg.approveForFlow(traceId, [HASH_A]);
            await expect(
                datasetReg.approveForFlow(traceId, [HASH_B])
            ).to.be.revertedWith("flow policy already set");
        });

        it("reverts if any hash is not in the global catalogue", async function () {
            await expect(
                datasetReg.approveForFlow(traceId, [HASH_A, UNREGISTERED])
            ).to.be.revertedWith("not in catalogue");
        });

        it("allows anyone (not just owner) to set a flow policy", async function () {
            await expect(
                datasetReg.connect(stranger).approveForFlow(traceId, [HASH_A])
            ).to.not.be.reverted;
        });

        it("empty hash list creates an empty (but valid) flow policy", async function () {
            await expect(datasetReg.approveForFlow(traceId, [])).to.not.be.reverted;
            expect(await datasetReg.flowPolicyExists(traceId)).to.be.true;
        });
    });

    // ── isApproved — opt-in logic ─────────────────────────────────────────────────

    describe("isApproved — opt-in logic", function () {
        const traceId = ethers.id("trace-isapproved");

        it("no global config, no flow policy → true for any hash", async function () {
            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, UNREGISTERED)).to.be.true;
            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, ethers.ZeroHash)).to.be.true;
        });

        it("global approved configured, no flow policy → hash must be globally approved", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_A);

            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_A)).to.be.true;
            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_B)).to.be.false;
        });

        it("no global config, flow policy set → hash must be in flow allowlist", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.approveForFlow(traceId, [HASH_A]);

            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_A)).to.be.true;
            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_B)).to.be.false;
        });

        it("both configured → hash must pass both checks", async function () {
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_B, "");
            await datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_A);
            await datasetReg.approveGlobally(CAP_REVIEW_CODE, HASH_B);
            await datasetReg.approveForFlow(traceId, [HASH_A]); // only HASH_A in this flow

            // HASH_A: globally approved AND in flow → true
            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_A)).to.be.true;
            // HASH_B: globally approved but NOT in flow → false
            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_B)).to.be.false;
        });

        it("different traceIds are independent", async function () {
            const traceId2 = ethers.id("trace-isapproved-2");
            await datasetReg.registerDataset(CAP_REVIEW_CODE, HASH_A, "");
            await datasetReg.approveForFlow(traceId, [HASH_A]);
            // no policy for traceId2 → opt-in

            expect(await datasetReg.isApproved(traceId, CAP_REVIEW_CODE, HASH_A)).to.be.true;
            expect(await datasetReg.isApproved(traceId2, CAP_REVIEW_CODE, HASH_A)).to.be.true; // opt-in
        });
    });
});
