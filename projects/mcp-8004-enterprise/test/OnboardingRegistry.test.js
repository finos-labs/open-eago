const { expect } = require("chai");
const { ethers }  = require("hardhat");

describe("OnboardingRegistry", function () {
    let registry;
    let owner, oracle1, oracle2, stranger;

    const FLOW_ID   = ethers.keccak256(ethers.toUtf8Bytes("flow-001"));
    const FLOW_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("flow-002"));
    const REASON    = ethers.toUtf8Bytes("AML rejected");

    beforeEach(async function () {
        [owner, oracle1, oracle2, stranger] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("OnboardingRegistry");
        registry = await Registry.deploy(owner.address);
        await registry.waitForDeployment();

        // Register oracle1 as an oracle
        await registry.setOracle(oracle1.address, true);
    });

    // ── setOracle ─────────────────────────────────────────────────────────────

    describe("setOracle()", function () {
        it("owner can enable and disable an oracle", async function () {
            await expect(registry.setOracle(oracle2.address, true))
                .to.emit(registry, "OracleSet").withArgs(oracle2.address, true);
            expect(await registry.isOracle(oracle2.address)).to.equal(true);

            await expect(registry.setOracle(oracle2.address, false))
                .to.emit(registry, "OracleSet").withArgs(oracle2.address, false);
            expect(await registry.isOracle(oracle2.address)).to.equal(false);
        });

        it("reverts for non-owner", async function () {
            await expect(
                registry.connect(stranger).setOracle(oracle2.address, true)
            ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
        });
    });

    // ── initiateOnboarding ────────────────────────────────────────────────────

    describe("initiateOnboarding()", function () {
        it("creates a flow and emits event", async function () {
            await expect(
                registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address)
            )
                .to.emit(registry, "OnboardingInitiated")
                .withArgs(FLOW_ID, stranger.address, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
        });

        it("flow is active after initiation", async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
            expect(await registry.isActive(FLOW_ID)).to.equal(true);
        });

        it("phaseBitmask starts at 0", async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
            expect(await registry.phaseBitmask(FLOW_ID)).to.equal(0);
        });

        it("reverts for non-oracle", async function () {
            await expect(
                registry.connect(stranger).initiateOnboarding(FLOW_ID, stranger.address)
            ).to.be.revertedWith("OnboardingRegistry: not an oracle");
        });

        it("reverts on zero flowId", async function () {
            await expect(
                registry.connect(oracle1).initiateOnboarding(ethers.ZeroHash, stranger.address)
            ).to.be.revertedWith("zero flowId");
        });

        it("reverts on duplicate flowId", async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
            await expect(
                registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address)
            ).to.be.revertedWith("flow already exists");
        });
    });

    // ── setPhaseComplete ──────────────────────────────────────────────────────

    describe("setPhaseComplete()", function () {
        beforeEach(async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
        });

        it("sets a phase bit and emits PhaseCompleted", async function () {
            const bit = await registry.PHASE_AML_CLEARED();
            await expect(registry.connect(oracle1).setPhaseComplete(FLOW_ID, bit))
                .to.emit(registry, "PhaseCompleted").withArgs(FLOW_ID, bit, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
            expect(await registry.phaseBitmask(FLOW_ID)).to.equal(bit);
        });

        it("accumulates bits across calls", async function () {
            const aml    = await registry.PHASE_AML_CLEARED();
            const credit = await registry.PHASE_CREDIT_APPROVED();
            await registry.connect(oracle1).setPhaseComplete(FLOW_ID, aml);
            await registry.connect(oracle1).setPhaseComplete(FLOW_ID, credit);
            expect(await registry.phaseBitmask(FLOW_ID)).to.equal(aml | credit);
        });

        it("emits ReadyToTransact when ALL_PHASES_DONE", async function () {
            // Set all 6 bits
            const bits = [
                await registry.PHASE_AML_CLEARED(),
                await registry.PHASE_CREDIT_APPROVED(),
                await registry.PHASE_LEGAL_EXECUTED(),
                await registry.PHASE_ENTITY_SETUP_DONE(),
                await registry.PHASE_ACCOUNT_SETUP_DONE(),
            ];
            for (const bit of bits) {
                await registry.connect(oracle1).setPhaseComplete(FLOW_ID, bit);
            }
            const productDone = await registry.PHASE_PRODUCT_SETUP_DONE();
            await expect(registry.connect(oracle1).setPhaseComplete(FLOW_ID, productDone))
                .to.emit(registry, "ReadyToTransact").withArgs(FLOW_ID, stranger.address, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));
        });

        it("reviewsDone() returns true once all three review bits are set", async function () {
            expect(await registry.reviewsDone(FLOW_ID)).to.equal(false);

            await registry.connect(oracle1).setPhaseComplete(FLOW_ID, await registry.PHASE_AML_CLEARED());
            await registry.connect(oracle1).setPhaseComplete(FLOW_ID, await registry.PHASE_CREDIT_APPROVED());
            expect(await registry.reviewsDone(FLOW_ID)).to.equal(false);

            await registry.connect(oracle1).setPhaseComplete(FLOW_ID, await registry.PHASE_LEGAL_EXECUTED());
            expect(await registry.reviewsDone(FLOW_ID)).to.equal(true);
        });

        it("reverts for non-oracle", async function () {
            await expect(
                registry.connect(stranger).setPhaseComplete(FLOW_ID, 0x01)
            ).to.be.revertedWith("OnboardingRegistry: not an oracle");
        });

        it("reverts if flow does not exist", async function () {
            await expect(
                registry.connect(oracle1).setPhaseComplete(FLOW_ID_2, 0x01)
            ).to.be.revertedWith("flow does not exist");
        });

        it("reverts if flow is terminated", async function () {
            await registry.connect(oracle1).terminate(FLOW_ID, REASON);
            await expect(
                registry.connect(oracle1).setPhaseComplete(FLOW_ID, 0x01)
            ).to.be.revertedWith("flow terminated");
        });
    });

    // ── terminate ─────────────────────────────────────────────────────────────

    describe("terminate()", function () {
        beforeEach(async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
        });

        it("sets terminated flag and emits event", async function () {
            await expect(registry.connect(oracle1).terminate(FLOW_ID, REASON))
                .to.emit(registry, "OnboardingTerminated");
            expect(await registry.isActive(FLOW_ID)).to.equal(false);
        });

        it("reverts on double termination", async function () {
            await registry.connect(oracle1).terminate(FLOW_ID, REASON);
            await expect(
                registry.connect(oracle1).terminate(FLOW_ID, REASON)
            ).to.be.revertedWith("already terminated");
        });

        it("reverts for non-oracle", async function () {
            await expect(
                registry.connect(stranger).terminate(FLOW_ID, REASON)
            ).to.be.revertedWith("OnboardingRegistry: not an oracle");
        });

        it("reverts if flow does not exist", async function () {
            await expect(
                registry.connect(oracle1).terminate(FLOW_ID_2, REASON)
            ).to.be.revertedWith("flow does not exist");
        });
    });

    // ── getFlow ───────────────────────────────────────────────────────────────

    describe("getFlow()", function () {
        it("returns full flow state", async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
            const [initiator, phases, terminated, reason, createdAt] =
                await registry.getFlow(FLOW_ID);
            expect(initiator).to.equal(stranger.address);
            expect(phases).to.equal(0);
            expect(terminated).to.equal(false);
            expect(reason).to.equal("0x");
            expect(createdAt).to.be.gt(0n);
        });

        it("includes termination reason after terminate()", async function () {
            await registry.connect(oracle1).initiateOnboarding(FLOW_ID, stranger.address);
            await registry.connect(oracle1).terminate(FLOW_ID, REASON);
            const [, , terminated, reason] = await registry.getFlow(FLOW_ID);
            expect(terminated).to.equal(true);
            expect(ethers.toUtf8String(reason)).to.equal("AML rejected");
        });
    });
});
