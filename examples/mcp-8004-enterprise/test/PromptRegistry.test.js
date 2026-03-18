const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("PromptRegistry", function () {
    let promptReg;
    let identity, traceLog, reviewerOracle, approverOracle;
    let owner, agent, requester, stranger;
    let agentId, approverAgentId;

    const CAP_REVIEW_CODE = ethers.id("review_code");
    const CAP_APPROVE_PR  = ethers.id("approve_pr");
    const UNKNOWN_CAP     = ethers.id("unknown_capability");

    const HASH_A     = ethers.keccak256(ethers.toUtf8Bytes("prompt template A"));
    const HASH_B     = ethers.keccak256(ethers.toUtf8Bytes("prompt template B"));
    const WRONG_HASH = ethers.keccak256(ethers.toUtf8Bytes("wrong template"));

    beforeEach(async function () {
        [owner, agent, requester, stranger] = await ethers.getSigners();

        // Deploy PromptRegistry
        const PromptReg = await ethers.getContractFactory("PromptRegistry");
        promptReg = await PromptReg.deploy();
        await promptReg.waitForDeployment();

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

    // ── constructor ──────────────────────────────────────────────────────────────

    describe("constructor", function () {
        it("sets owner to deployer", async function () {
            expect(await promptReg.owner()).to.equal(owner.address);
        });
    });

    // ── registerPrompt ────────────────────────────────────────────────────────────

    describe("registerPrompt", function () {
        it("emits PromptRegistered and increments getVersionCount", async function () {
            await expect(promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "agents/mcp/code-reviewer.mcp.json"))
                .to.emit(promptReg, "PromptRegistered")
                .withArgs(CAP_REVIEW_CODE, 0n, HASH_A, "agents/mcp/code-reviewer.mcp.json");

            expect(await promptReg.getVersionCount(CAP_REVIEW_CODE)).to.equal(1n);

            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_B, "");
            expect(await promptReg.getVersionCount(CAP_REVIEW_CODE)).to.equal(2n);
        });

        it("reverts with zero templateHash", async function () {
            await expect(
                promptReg.registerPrompt(CAP_REVIEW_CODE, ethers.ZeroHash, "")
            ).to.be.revertedWith("templateHash required");
        });

        it("reverts from non-owner", async function () {
            await expect(
                promptReg.connect(stranger).registerPrompt(CAP_REVIEW_CODE, HASH_A, "")
            ).to.be.revertedWith("only owner");
        });
    });

    // ── setActiveVersion ──────────────────────────────────────────────────────────

    describe("setActiveVersion", function () {
        beforeEach(async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "");  // v0
        });

        it("emits PromptActivated with correct fields", async function () {
            await expect(promptReg.setActiveVersion(CAP_REVIEW_CODE, 0))
                .to.emit(promptReg, "PromptActivated")
                .withArgs(CAP_REVIEW_CODE, 0n, HASH_A);
        });

        it("reverts on out-of-range version", async function () {
            await expect(
                promptReg.setActiveVersion(CAP_REVIEW_CODE, 1)
            ).to.be.revertedWith("version does not exist");
        });

        it("reverts from non-owner", async function () {
            await expect(
                promptReg.connect(stranger).setActiveVersion(CAP_REVIEW_CODE, 0)
            ).to.be.revertedWith("only owner");
        });
    });

    // ── deactivate ────────────────────────────────────────────────────────────────

    describe("deactivate", function () {
        beforeEach(async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "");
            await promptReg.setActiveVersion(CAP_REVIEW_CODE, 0);
        });

        it("emits PromptDeactivated", async function () {
            await expect(promptReg.deactivate(CAP_REVIEW_CODE))
                .to.emit(promptReg, "PromptDeactivated")
                .withArgs(CAP_REVIEW_CODE);
        });

        it("restores opt-in: isActive returns true for any hash after deactivate", async function () {
            await promptReg.deactivate(CAP_REVIEW_CODE);
            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_A)).to.be.true;
            expect(await promptReg.isActive(CAP_REVIEW_CODE, WRONG_HASH)).to.be.true;
        });

        it("reverts when no active version is set", async function () {
            await promptReg.deactivate(CAP_REVIEW_CODE);
            await expect(promptReg.deactivate(CAP_REVIEW_CODE)).to.be.revertedWith("no active version");
        });
    });

    // ── isActive — opt-in ──────────────────────────────────────────────────────────

    describe("isActive — opt-in", function () {
        it("returns true when no active version is configured (backward compat)", async function () {
            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_A)).to.be.true;
            expect(await promptReg.isActive(CAP_REVIEW_CODE, ethers.ZeroHash)).to.be.true;
        });

        it("returns true after registering a prompt but before activating it", async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "");
            expect(await promptReg.isActive(CAP_REVIEW_CODE, WRONG_HASH)).to.be.true;
        });
    });

    // ── isActive — active version ─────────────────────────────────────────────────

    describe("isActive — active version", function () {
        beforeEach(async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "");
            await promptReg.setActiveVersion(CAP_REVIEW_CODE, 0);
        });

        it("returns true for the correct hash", async function () {
            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_A)).to.be.true;
        });

        it("returns false for a wrong hash", async function () {
            expect(await promptReg.isActive(CAP_REVIEW_CODE, WRONG_HASH)).to.be.false;
        });

        it("multiple versions: activating v1 rejects v0 hash", async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_B, "");  // v1
            await promptReg.setActiveVersion(CAP_REVIEW_CODE, 1);

            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_B)).to.be.true;
            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_A)).to.be.false;
        });

        it("rollback: re-activating v0 after v1 rejects v1 hash", async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_B, "");  // v1
            await promptReg.setActiveVersion(CAP_REVIEW_CODE, 1);
            await promptReg.setActiveVersion(CAP_REVIEW_CODE, 0);  // rollback

            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_A)).to.be.true;
            expect(await promptReg.isActive(CAP_REVIEW_CODE, HASH_B)).to.be.false;
        });
    });

    // ── getActivePrompt / getPromptVersion ────────────────────────────────────────

    describe("getActivePrompt / getPromptVersion", function () {
        it("getActivePrompt returns correct fields when active", async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "agents/mcp/code-reviewer.mcp.json");
            await promptReg.setActiveVersion(CAP_REVIEW_CODE, 0);

            const [version, hash, uri, active] = await promptReg.getActivePrompt(CAP_REVIEW_CODE);
            expect(version).to.equal(0n);
            expect(hash).to.equal(HASH_A);
            expect(uri).to.equal("agents/mcp/code-reviewer.mcp.json");
            expect(active).to.be.true;
        });

        it("getActivePrompt returns (0, ZeroHash, '', false) when no active version", async function () {
            const [, hash, , active] = await promptReg.getActivePrompt(CAP_REVIEW_CODE);
            expect(hash).to.equal(ethers.ZeroHash);
            expect(active).to.be.false;
        });

        it("getPromptVersion returns stored templateHash, metadataUri, registeredAt", async function () {
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_A, "uri-a");
            await promptReg.registerPrompt(CAP_REVIEW_CODE, HASH_B, "uri-b");

            const [hashA, uriA] = await promptReg.getPromptVersion(CAP_REVIEW_CODE, 0);
            expect(hashA).to.equal(HASH_A);
            expect(uriA).to.equal("uri-a");

            const [hashB, uriB] = await promptReg.getPromptVersion(CAP_REVIEW_CODE, 1);
            expect(hashB).to.equal(HASH_B);
            expect(uriB).to.equal("uri-b");
        });

        it("getPromptVersion reverts for out-of-range version", async function () {
            await expect(
                promptReg.getPromptVersion(CAP_REVIEW_CODE, 0)
            ).to.be.revertedWith("version does not exist");
        });
    });
});
