const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("ReputationGate", function () {
    let repRegistry, repGate;
    let identity, traceLog, reviewerOracle, approverOracle;
    let owner, agent, evaluator, requester, stranger;
    let agentId, approverAgentId;

    const CAP_REVIEW_CODE = ethers.id("review_code");
    const CAP_APPROVE_PR  = ethers.id("approve_pr");

    beforeEach(async function () {
        [owner, agent, evaluator, requester, stranger] = await ethers.getSigners();

        // Deploy IdentityRegistry
        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        // Deploy ReputationRegistry
        const RepReg = await ethers.getContractFactory("ReputationRegistryUpgradeable");
        repRegistry = await upgrades.deployProxy(RepReg, [await identity.getAddress()], { initializer: "initialize" });
        await repRegistry.waitForDeployment();

        // Deploy ReputationGate
        const RepGate = await ethers.getContractFactory("ReputationGate");
        repGate = await RepGate.deploy(await repRegistry.getAddress());
        await repGate.waitForDeployment();

        // Deploy oracle infrastructure
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

    // ── helper: give feedback from evaluator ──────────────────────────────────────

    async function giveFeedback(agentIdTarget, score, tag) {
        await repRegistry.connect(evaluator).giveFeedback(
            agentIdTarget,
            score,       // int128 value
            0,           // uint8 valueDecimals
            tag,         // string tag1
            "",          // string tag2
            "",          // string endpoint
            "",          // string feedbackURI
            ethers.ZeroHash  // bytes32 feedbackHash
        );
    }

    // ── constructor ──────────────────────────────────────────────────────────────

    describe("constructor", function () {
        it("stores the reputation registry address", async function () {
            expect(await repGate.reputationRegistry()).to.equal(await repRegistry.getAddress());
        });

        it("reverts with zero reputation registry", async function () {
            const RepGate = await ethers.getContractFactory("ReputationGate");
            await expect(RepGate.deploy(ethers.ZeroAddress))
                .to.be.revertedWith("zero reputation registry");
        });
    });

    // ── meetsThreshold — opt-in behaviour ────────────────────────────────────────

    describe("meetsThreshold — opt-in", function () {
        it("returns true when no threshold is configured (backward compat)", async function () {
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });

        it("returns true when threshold exists but no evaluators are configured", async function () {
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "review_code");
            // No evaluators added — getSummary would revert, gate should return true
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });
    });

    // ── setThreshold / removeThreshold ───────────────────────────────────────────

    describe("setThreshold / removeThreshold", function () {
        it("emits ThresholdSet with all parameters", async function () {
            await expect(
                repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "review_code")
            ).to.emit(repGate, "ThresholdSet")
             .withArgs(CAP_REVIEW_CODE, 50n, 0, 1n, "review_code");
        });

        it("reverts setThreshold when scoreDecimals > 18", async function () {
            await expect(
                repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 19, 1, "")
            ).to.be.revertedWith("scoreDecimals > 18");
        });

        it("reverts setThreshold from non-owner", async function () {
            await expect(
                repGate.connect(stranger).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "")
            ).to.be.revertedWith("not owner");
        });

        it("thresholdExists returns correct values before and after", async function () {
            expect(await repGate.thresholdExists(CAP_REVIEW_CODE)).to.be.false;
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "");
            expect(await repGate.thresholdExists(CAP_REVIEW_CODE)).to.be.true;
        });

        it("getThreshold returns stored values", async function () {
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 75, 2, 3, "review_code");
            const [minScore, scoreDecimals, minCount, tag, exists] =
                await repGate.getThreshold(CAP_REVIEW_CODE);
            expect(minScore).to.equal(75n);
            expect(scoreDecimals).to.equal(2);
            expect(minCount).to.equal(3n);
            expect(tag).to.equal("review_code");
            expect(exists).to.be.true;
        });

        it("removeThreshold emits ThresholdRemoved and restores opt-in", async function () {
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "");
            await repGate.connect(owner).addEvaluator(evaluator.address);
            await giveFeedback(agentId, 10, ""); // below threshold

            // Threshold active → below threshold
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.false;

            // Remove threshold
            await expect(repGate.connect(owner).removeThreshold(CAP_REVIEW_CODE))
                .to.emit(repGate, "ThresholdRemoved").withArgs(CAP_REVIEW_CODE);

            // Opt-in restored
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });

        it("removeThreshold reverts when no threshold exists", async function () {
            await expect(repGate.connect(owner).removeThreshold(CAP_REVIEW_CODE))
                .to.be.revertedWith("no threshold");
        });
    });

    // ── addEvaluator / removeEvaluator ───────────────────────────────────────────

    describe("addEvaluator / removeEvaluator", function () {
        it("emits EvaluatorAdded and appears in getEvaluators", async function () {
            await expect(repGate.connect(owner).addEvaluator(evaluator.address))
                .to.emit(repGate, "EvaluatorAdded").withArgs(evaluator.address);

            const evals = await repGate.getEvaluators();
            expect(evals).to.deep.equal([evaluator.address]);
        });

        it("reverts addEvaluator for zero address", async function () {
            await expect(repGate.connect(owner).addEvaluator(ethers.ZeroAddress))
                .to.be.revertedWith("zero evaluator");
        });

        it("reverts addEvaluator for duplicate address", async function () {
            await repGate.connect(owner).addEvaluator(evaluator.address);
            await expect(repGate.connect(owner).addEvaluator(evaluator.address))
                .to.be.revertedWith("already evaluator");
        });

        it("reverts addEvaluator from non-owner", async function () {
            await expect(repGate.connect(stranger).addEvaluator(evaluator.address))
                .to.be.revertedWith("not owner");
        });

        it("emits EvaluatorRemoved and removes from getEvaluators", async function () {
            await repGate.connect(owner).addEvaluator(evaluator.address);
            await expect(repGate.connect(owner).removeEvaluator(evaluator.address))
                .to.emit(repGate, "EvaluatorRemoved").withArgs(evaluator.address);

            expect(await repGate.getEvaluators()).to.be.empty;
        });

        it("reverts removeEvaluator for non-evaluator", async function () {
            await expect(repGate.connect(owner).removeEvaluator(stranger.address))
                .to.be.revertedWith("not evaluator");
        });
    });

    // ── meetsThreshold — score and count checks ───────────────────────────────────

    describe("meetsThreshold — score and count", function () {
        beforeEach(async function () {
            await repGate.connect(owner).addEvaluator(evaluator.address);
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "review_code");
        });

        it("returns true when agent meets both score and count", async function () {
            await giveFeedback(agentId, 80, "review_code"); // 80 >= 50, count 1 >= 1
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });

        it("returns false when count is below minCount", async function () {
            // No feedback given — count = 0 < 1
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.false;
        });

        it("returns false when score is below minScore", async function () {
            await giveFeedback(agentId, 30, "review_code"); // 30 < 50
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.false;
        });

        it("returns true at exactly the minimum score (boundary)", async function () {
            await giveFeedback(agentId, 50, "review_code"); // exactly 50 == 50
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });

        it("tag filter: feedback with wrong tag does not count", async function () {
            // Give feedback tagged "other" — threshold filters for "review_code"
            await giveFeedback(agentId, 90, "other");
            // count = 0 for "review_code" tag → fails minCount
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.false;
        });
    });

    // ── decimal normalization ─────────────────────────────────────────────────────

    describe("meetsThreshold — decimal normalization", function () {
        it("correctly compares threshold scoreDecimals=2 with feedback decimals=0", async function () {
            await repGate.connect(owner).addEvaluator(evaluator.address);
            // threshold: 5000 with 2 decimals = 50.00
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 5000, 2, 1, "");

            // feedback: 80 with 0 decimals = 80 — should pass (80 >= 50.00)
            await giveFeedback(agentId, 80, "");
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });

        it("correctly compares threshold scoreDecimals=0 with feedback decimals=2", async function () {
            await repGate.connect(owner).addEvaluator(evaluator.address);
            // threshold: 50 with 0 decimals = 50
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "");

            // Give two feedbacks so mode decimals = 2: 8000 (= 80.00) and 7500 (= 75.00)
            await repRegistry.connect(evaluator).giveFeedback(
                agentId, 8000, 2, "", "", "", "", ethers.ZeroHash
            );
            await repRegistry.connect(evaluator).giveFeedback(
                agentId, 7500, 2, "", "", "", "", ethers.ZeroHash
            );
            // avg = 77.50 with decimals=2; threshold = 50 with decimals=0 → 77.50 >= 50 → true
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
        });
    });

    // ── per-capability thresholds ─────────────────────────────────────────────────

    describe("meetsThreshold — per-capability", function () {
        it("agent passes review_code threshold but not approve_pr threshold", async function () {
            await repGate.connect(owner).addEvaluator(evaluator.address);
            await repGate.connect(owner).setThreshold(CAP_REVIEW_CODE, 50, 0, 1, "");
            await repGate.connect(owner).setThreshold(CAP_APPROVE_PR,  90, 0, 1, "");

            await giveFeedback(agentId, 70, ""); // 70 >= 50 ✓, 70 < 90 ✗
            expect(await repGate.meetsThreshold(agentId, CAP_REVIEW_CODE)).to.be.true;
            expect(await repGate.meetsThreshold(agentId, CAP_APPROVE_PR)).to.be.false;
        });
    });
});
