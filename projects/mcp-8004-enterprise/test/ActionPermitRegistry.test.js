const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("ActionPermitRegistry", function () {
    let registry;
    let owner, initiator, agent2, approver1, approver2, stranger;

    // Canonical action type hashes
    const REVIEW_PR  = ethers.id("review_pr");
    const APPROVE_PR = ethers.id("approve_pr");
    const SQL_DROP   = ethers.id("SQL:DROP");
    const SQL_SELECT = ethers.id("SQL:SELECT");
    const SHELL_RMRF = ethers.id("SHELL:RM_RF");

    const FLOW_A = ethers.id("flow-a");
    const FLOW_B = ethers.id("flow-b");
    const AGENT_ID = 1n;

    beforeEach(async function () {
        [owner, initiator, agent2, approver1, approver2, stranger] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("ActionPermitRegistry");
        registry = await Registry.deploy();
        await registry.waitForDeployment();
    });

    // ── registerPattern ───────────────────────────────────────────────────────

    describe("registerPattern", function () {
        it("stores the pattern and emits ActionPatternRegistered", async function () {
            await expect(registry.connect(owner).registerPattern(SQL_DROP, 2))
                .to.emit(registry, "ActionPatternRegistered")
                .withArgs(SQL_DROP, 2);

            const [registered, tier] = await registry.getPattern(SQL_DROP);
            expect(registered).to.be.true;
            expect(tier).to.equal(2);
        });

        it("allows overwriting a pattern tier", async function () {
            await registry.connect(owner).registerPattern(SQL_SELECT, 0);
            await registry.connect(owner).registerPattern(SQL_SELECT, 1); // promote to tier 1

            const [, tier] = await registry.getPattern(SQL_SELECT);
            expect(tier).to.equal(1);
        });

        it("reverts from non-owner", async function () {
            await expect(registry.connect(stranger).registerPattern(SQL_DROP, 2))
                .to.be.revertedWith("not owner");
        });

        it("reverts with zero patternHash", async function () {
            await expect(registry.connect(owner).registerPattern(ethers.ZeroHash, 1))
                .to.be.revertedWith("zero patternHash");
        });

        it("reverts with invalid tier (> 3)", async function () {
            await expect(registry.connect(owner).registerPattern(SQL_DROP, 4))
                .to.be.revertedWith("invalid tier");
        });

        it("registers tier 3 (forbidden) patterns", async function () {
            await registry.connect(owner).registerPattern(SHELL_RMRF, 3);
            const [registered, tier] = await registry.getPattern(SHELL_RMRF);
            expect(registered).to.be.true;
            expect(tier).to.equal(3);
        });
    });

    // ── validateAction — decision table ──────────────────────────────────────

    describe("validateAction", function () {
        it("returns true for an unregistered action type (opt-in default)", async function () {
            const unknown = ethers.id("UNKNOWN:ACTION");
            expect(await registry.validateAction(FLOW_A, AGENT_ID, unknown)).to.be.true;
        });

        it("returns true for a Tier 0 (read-only) registered pattern", async function () {
            await registry.connect(owner).registerPattern(SQL_SELECT, 0);
            expect(await registry.validateAction(FLOW_A, AGENT_ID, SQL_SELECT)).to.be.true;
        });

        it("returns false for a Tier 3 (forbidden) pattern regardless of permits", async function () {
            await registry.connect(owner).registerPattern(SHELL_RMRF, 3);
            // Even granting should not work — and grantPermit with tier 3 should revert
            expect(await registry.validateAction(FLOW_A, AGENT_ID, SHELL_RMRF)).to.be.false;
        });

        it("returns false for a Tier 1 pattern when no permit exists", async function () {
            await registry.connect(owner).registerPattern(APPROVE_PR, 1);
            expect(await registry.validateAction(FLOW_A, AGENT_ID, APPROVE_PR)).to.be.false;
        });

        it("returns true for a Tier 1 pattern when an approved permit exists", async function () {
            await registry.connect(owner).registerPattern(APPROVE_PR, 1);
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);

            expect(await registry.validateAction(FLOW_A, AGENT_ID, APPROVE_PR)).to.be.true;
        });

        it("returns false for a Tier 2 pattern with a pending (unapproved) permit", async function () {
            await registry.connect(owner).registerPattern(SQL_DROP, 2);
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 2);

            expect(await registry.validateAction(FLOW_A, AGENT_ID, SQL_DROP)).to.be.false;
        });

        it("returns true for a Tier 2 pattern once enough approvals are collected", async function () {
            await registry.connect(owner).registerPattern(SQL_DROP, 2);
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 2);

            await registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP);
            await registry.connect(approver2).approveAction(FLOW_A, AGENT_ID, SQL_DROP);

            expect(await registry.validateAction(FLOW_A, AGENT_ID, SQL_DROP)).to.be.true;
        });

        it("is scoped per (flowId, agentId, actionType) — different flow returns false", async function () {
            await registry.connect(owner).registerPattern(APPROVE_PR, 1);
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);

            // FLOW_B has no permit
            expect(await registry.validateAction(FLOW_B, AGENT_ID, APPROVE_PR)).to.be.false;
        });

        it("is scoped per agentId — different agent returns false", async function () {
            await registry.connect(owner).registerPattern(APPROVE_PR, 1);
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);

            expect(await registry.validateAction(FLOW_A, 2n, APPROVE_PR)).to.be.false;
        });
    });

    // ── grantPermit ───────────────────────────────────────────────────────────

    describe("grantPermit", function () {
        it("emits ActionPermitGranted and ActionPermitResolved for Tier 1", async function () {
            await expect(
                registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0)
            )
                .to.emit(registry, "ActionPermitGranted")
                .withArgs(FLOW_A, AGENT_ID, APPROVE_PR, 1)
                .and.to.emit(registry, "ActionPermitResolved")
                .withArgs(FLOW_A, AGENT_ID, APPROVE_PR, true);
        });

        it("emits ActionPermitGranted but NOT ActionPermitResolved for pending Tier 2", async function () {
            const tx = await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 2);
            const receipt = await tx.wait();
            const resolved = receipt.logs
                .map(l => { try { return registry.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "ActionPermitResolved");
            expect(resolved).to.not.exist;
        });

        it("sets the flow initiator on first call", async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);
            expect(await registry.getFlowInitiator(FLOW_A)).to.equal(initiator.address);
        });

        it("reverts when a different address tries to grant for the same flow", async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);

            await expect(
                registry.connect(stranger).grantPermit(FLOW_A, 2n, SQL_SELECT, 1, 0)
            ).to.be.revertedWith("not flow initiator");
        });

        it("reverts when granting tier 3", async function () {
            await expect(
                registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SHELL_RMRF, 3, 0)
            ).to.be.revertedWith("tier 3 cannot be permitted");
        });

        it("reverts on invalid tier (> 3)", async function () {
            await expect(
                registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 4, 0)
            ).to.be.revertedWith("invalid tier");
        });

        it("reverts on zero flowId", async function () {
            await expect(
                registry.connect(initiator).grantPermit(ethers.ZeroHash, AGENT_ID, APPROVE_PR, 1, 0)
            ).to.be.revertedWith("zero flowId");
        });

        it("reverts on zero actionType", async function () {
            await expect(
                registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, ethers.ZeroHash, 1, 0)
            ).to.be.revertedWith("zero actionType");
        });

        it("reverts when permit already exists", async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);
            await expect(
                registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0)
            ).to.be.revertedWith("permit already exists");
        });

        it("Tier 2 with requiredApprovals == 0 is immediately approved", async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 0);
            expect(await registry.validateAction(FLOW_A, AGENT_ID, SQL_DROP)).to.be.true;
        });
    });

    // ── approveAction ─────────────────────────────────────────────────────────

    describe("approveAction", function () {
        beforeEach(async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 2);
        });

        it("increments approvalCount and emits ActionPermitApproved", async function () {
            await expect(registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP))
                .to.emit(registry, "ActionPermitApproved")
                .withArgs(FLOW_A, AGENT_ID, SQL_DROP, approver1.address);

            const [, , , count] = await registry.getPermit(FLOW_A, AGENT_ID, SQL_DROP);
            expect(count).to.equal(1n);
        });

        it("emits ActionPermitResolved when threshold is reached", async function () {
            await registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP);
            await expect(registry.connect(approver2).approveAction(FLOW_A, AGENT_ID, SQL_DROP))
                .to.emit(registry, "ActionPermitResolved")
                .withArgs(FLOW_A, AGENT_ID, SQL_DROP, true);
        });

        it("reverts on duplicate vote from the same address", async function () {
            await registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP);
            await expect(registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP))
                .to.be.revertedWith("already voted");
        });

        it("reverts when permit is already approved", async function () {
            await registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP);
            await registry.connect(approver2).approveAction(FLOW_A, AGENT_ID, SQL_DROP);

            await expect(registry.connect(stranger).approveAction(FLOW_A, AGENT_ID, SQL_DROP))
                .to.be.revertedWith("already approved");
        });

        it("reverts when no permit exists", async function () {
            await expect(
                registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, APPROVE_PR)
            ).to.be.revertedWith("permit not found");
        });
    });

    // ── revokePermit ──────────────────────────────────────────────────────────

    describe("revokePermit", function () {
        beforeEach(async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);
        });

        it("flow initiator can revoke and emits ActionPermitRevoked", async function () {
            await expect(registry.connect(initiator).revokePermit(FLOW_A, AGENT_ID, APPROVE_PR))
                .to.emit(registry, "ActionPermitRevoked")
                .withArgs(FLOW_A, AGENT_ID, APPROVE_PR);
        });

        it("validateAction returns false after revocation", async function () {
            await registry.connect(owner).registerPattern(APPROVE_PR, 1);
            await registry.connect(initiator).revokePermit(FLOW_A, AGENT_ID, APPROVE_PR);
            expect(await registry.validateAction(FLOW_A, AGENT_ID, APPROVE_PR)).to.be.false;
        });

        it("owner can revoke any permit", async function () {
            await expect(registry.connect(owner).revokePermit(FLOW_A, AGENT_ID, APPROVE_PR))
                .to.emit(registry, "ActionPermitRevoked");
        });

        it("stranger cannot revoke", async function () {
            await expect(registry.connect(stranger).revokePermit(FLOW_A, AGENT_ID, APPROVE_PR))
                .to.be.revertedWith("not authorized to revoke");
        });

        it("reverts when permit does not exist", async function () {
            await expect(registry.connect(initiator).revokePermit(FLOW_A, AGENT_ID, SQL_DROP))
                .to.be.revertedWith("permit not found");
        });
    });

    // ── setParticipantRegistry / credentialed approvers (P2b) ─────────────────

    describe("setParticipantRegistry", function () {
        it("owner can set and getter reflects it", async function () {
            await registry.connect(owner).setParticipantRegistry(stranger.address);
            expect(await registry.getParticipantRegistry()).to.equal(stranger.address);
        });

        it("non-owner cannot set", async function () {
            await expect(
                registry.connect(stranger).setParticipantRegistry(stranger.address)
            ).to.be.revertedWith("not owner");
        });

        it("emits ParticipantRegistrySet", async function () {
            await expect(registry.connect(owner).setParticipantRegistry(approver1.address))
                .to.emit(registry, "ParticipantRegistrySet")
                .withArgs(approver1.address);
        });
    });

    describe("approveAction with credentialed approver gate", function () {
        let participant, registryWithGate;

        beforeEach(async function () {
            // Deploy ParticipantRegistry and register approver1 as a standard approver.
            const PR = await ethers.getContractFactory("ParticipantRegistry");
            participant = await PR.deploy(owner.address);
            await participant.waitForDeployment();

            const pid = ethers.id("BANK_A");
            await participant.registerParticipant(
                pid,
                0,   // BANK
                0,   // BANK_INTERNAL
                [],          // minters
                [approver1.address],  // approvers
                []           // seniorApprovers
            );

            // Wire the gate into the registry.
            registryWithGate = registry;
            await registryWithGate.connect(owner).setParticipantRegistry(
                await participant.getAddress()
            );

            // Grant a Tier 2 permit.
            await registryWithGate.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 1);
        });

        it("credentialed approver (isApprover) can approve", async function () {
            await expect(
                registryWithGate.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP)
            ).to.emit(registryWithGate, "ActionPermitApproved");
        });

        it("stranger (not a credentialed approver) is blocked", async function () {
            await expect(
                registryWithGate.connect(stranger).approveAction(FLOW_A, AGENT_ID, SQL_DROP)
            ).to.be.revertedWith("caller is not a credentialed approver");
        });

        it("senior approver can also approve", async function () {
            const PR = await ethers.getContractFactory("ParticipantRegistry");
            const pr2 = await PR.deploy(owner.address);
            await pr2.waitForDeployment();
            const pid = ethers.id("BANK_B");
            await pr2.registerParticipant(pid, 0, 0, [], [], [approver2.address]);

            await registryWithGate.connect(owner).setParticipantRegistry(await pr2.getAddress());
            await registryWithGate.connect(initiator).grantPermit(FLOW_B, AGENT_ID, SQL_DROP, 2, 1);

            await expect(
                registryWithGate.connect(approver2).approveAction(FLOW_B, AGENT_ID, SQL_DROP)
            ).to.emit(registryWithGate, "ActionPermitApproved");
        });
    });

    // ── getPermit ─────────────────────────────────────────────────────────────

    describe("getPermit", function () {
        it("returns (false, ...) when no permit exists", async function () {
            const [exists] = await registry.getPermit(FLOW_A, AGENT_ID, APPROVE_PR);
            expect(exists).to.be.false;
        });

        it("returns correct values for an approved Tier 1 permit", async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, APPROVE_PR, 1, 0);
            const [exists, tier, approved, count, required] =
                await registry.getPermit(FLOW_A, AGENT_ID, APPROVE_PR);
            expect(exists).to.be.true;
            expect(tier).to.equal(1);
            expect(approved).to.be.true;
            expect(count).to.equal(0n);
            expect(required).to.equal(0n);
        });

        it("returns correct values for a pending Tier 2 permit", async function () {
            await registry.connect(initiator).grantPermit(FLOW_A, AGENT_ID, SQL_DROP, 2, 3);
            await registry.connect(approver1).approveAction(FLOW_A, AGENT_ID, SQL_DROP);

            const [exists, tier, approved, count, required] =
                await registry.getPermit(FLOW_A, AGENT_ID, SQL_DROP);
            expect(exists).to.be.true;
            expect(tier).to.equal(2);
            expect(approved).to.be.false;
            expect(count).to.equal(1n);
            expect(required).to.equal(3n);
        });
    });
});
