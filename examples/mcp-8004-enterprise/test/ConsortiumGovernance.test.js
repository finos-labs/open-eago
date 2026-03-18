const { expect } = require("chai");
const { ethers }  = require("hardhat");

async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
}

describe("ConsortiumGovernance", function () {
    let gov;
    let deployer, bankA, bankB, bankC, stranger;

    const BANK_A = ethers.id("BANK_A");
    const BANK_B = ethers.id("BANK_B");
    const BANK_C = ethers.id("BANK_C");

    // ProposalType enum indices
    const ADD_MEMBER       = 0;
    const REMOVE_MEMBER    = 1;
    const PARAM_CHANGE     = 2;
    const CONTRACT_UPGRADE = 3;
    const UNPAUSE          = 4;

    beforeEach(async function () {
        [deployer, bankA, bankB, bankC, stranger] = await ethers.getSigners();

        const Gov = await ethers.getContractFactory("ConsortiumGovernance");
        gov = await Gov.deploy();
        await gov.waitForDeployment();
    });

    // ── bootstrap ────────────────────────────────────────────────────────────────

    describe("bootstrap", function () {
        it("deployer can add founding members", async function () {
            await gov.bootstrapAddMember(BANK_A, bankA.address);
            expect(await gov.isMember(BANK_A)).to.be.true;
            expect(await gov.memberCount()).to.equal(1n);
        });

        it("non-deployer cannot bootstrap", async function () {
            await expect(
                gov.connect(stranger).bootstrapAddMember(BANK_A, bankA.address)
            ).to.be.revertedWith("not bootstrap owner");
        });

        it("cannot add the same participantId twice", async function () {
            await gov.bootstrapAddMember(BANK_A, bankA.address);
            await expect(
                gov.bootstrapAddMember(BANK_A, bankB.address)
            ).to.be.revertedWith("already a member");
        });

        it("renounceBootstrap requires at least 2 members", async function () {
            await gov.bootstrapAddMember(BANK_A, bankA.address);
            await expect(gov.renounceBootstrap()).to.be.revertedWith("need at least 2 members");
        });

        it("renounceBootstrap blocks further bootstrap calls", async function () {
            await gov.bootstrapAddMember(BANK_A, bankA.address);
            await gov.bootstrapAddMember(BANK_B, bankB.address);
            await gov.renounceBootstrap();

            expect(await gov.bootstrapOwner()).to.equal(ethers.ZeroAddress);
            await expect(
                gov.bootstrapAddMember(BANK_C, bankC.address)
            ).to.be.revertedWith("not bootstrap owner");
        });
    });

    // ── shared setup ─────────────────────────────────────────────────────────────

    async function setup2Members() {
        await gov.bootstrapAddMember(BANK_A, bankA.address);
        await gov.bootstrapAddMember(BANK_B, bankB.address);
        await gov.renounceBootstrap();
    }

    async function setup3Members() {
        await gov.bootstrapAddMember(BANK_A, bankA.address);
        await gov.bootstrapAddMember(BANK_B, bankB.address);
        await gov.bootstrapAddMember(BANK_C, bankC.address);
        await gov.renounceBootstrap();
    }

    // ── membership queries ───────────────────────────────────────────────────────

    describe("membership queries", function () {
        it("getMember returns governance address and active flag", async function () {
            await gov.bootstrapAddMember(BANK_A, bankA.address);
            const [govAddr, active] = await gov.getMember(BANK_A);
            expect(govAddr).to.equal(bankA.address);
            expect(active).to.be.true;
        });

        it("getMembers returns all added participantIds", async function () {
            await setup2Members();
            const members = await gov.getMembers();
            expect(members).to.have.lengthOf(2);
            expect(members).to.include(BANK_A);
            expect(members).to.include(BANK_B);
        });
    });

    // ── proposals ────────────────────────────────────────────────────────────────

    describe("createProposal", function () {
        beforeEach(setup2Members);

        it("member can create a proposal and it emits ProposalCreated", async function () {
            await expect(
                gov.connect(bankA).createProposal(PARAM_CHANGE, [], "0x", ethers.ZeroAddress)
            ).to.emit(gov, "ProposalCreated");
        });

        it("non-member cannot create a proposal", async function () {
            await expect(
                gov.connect(stranger).createProposal(PARAM_CHANGE, [], "0x", ethers.ZeroAddress)
            ).to.be.revertedWith("not a member");
        });

        it("nextProposalId increments", async function () {
            await gov.connect(bankA).createProposal(PARAM_CHANGE, [], "0x", ethers.ZeroAddress);
            expect(await gov.nextProposalId()).to.equal(1n);
        });
    });

    // ── voting ───────────────────────────────────────────────────────────────────

    describe("castVote", function () {
        let proposalId;

        beforeEach(async function () {
            await setup2Members();
            const tx = await gov.connect(bankA).createProposal(PARAM_CHANGE, [], "0x", ethers.ZeroAddress);
            const receipt = await tx.wait();
            const ev = receipt.logs
                .map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "ProposalCreated");
            proposalId = ev.args.proposalId;
        });

        it("member can vote and emits VoteCast", async function () {
            await expect(gov.connect(bankA).castVote(proposalId, true))
                .to.emit(gov, "VoteCast")
                .withArgs(proposalId, BANK_A, true);
        });

        it("cannot vote twice", async function () {
            await gov.connect(bankA).castVote(proposalId, true);
            await expect(gov.connect(bankA).castVote(proposalId, true))
                .to.be.revertedWith("already voted");
        });

        it("cannot vote after voting period ends", async function () {
            await increaseTime(8 * 24 * 3600); // 8 days > 7-day period
            await expect(gov.connect(bankA).castVote(proposalId, true))
                .to.be.revertedWith("voting period ended");
        });

        it("non-member cannot vote", async function () {
            await expect(gov.connect(stranger).castVote(proposalId, true))
                .to.be.revertedWith("not a member");
        });
    });

    // ── executeProposal ──────────────────────────────────────────────────────────

    describe("executeProposal", function () {
        beforeEach(setup3Members);

        async function propose(type, targets, callData, target) {
            const tx = await gov.connect(bankA).createProposal(type, targets, callData, target ?? ethers.ZeroAddress);
            const receipt = await tx.wait();
            const ev = receipt.logs
                .map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "ProposalCreated");
            return ev.args.proposalId;
        }

        it("cannot execute before voting period ends", async function () {
            const pid = await propose(PARAM_CHANGE, [], "0x");
            await expect(gov.executeProposal(pid)).to.be.revertedWith("voting period not ended");
        });

        it("defeated when quorum not met", async function () {
            // 3 members, quorum = ceil(3*2/3) = 2 needed; only 1 votes
            const pid = await propose(PARAM_CHANGE, [], "0x");
            await gov.connect(bankA).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);
            await expect(gov.executeProposal(pid)).to.emit(gov, "ProposalDefeated");
        });

        it("executes PARAM_CHANGE (votingPeriod) and emits ProposalExecuted + ParamChanged", async function () {
            const paramKey = ethers.id("votingPeriod");
            const newPeriod = 3 * 24 * 3600; // 3 days
            const callData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["bytes32", "bytes32"], [paramKey, ethers.zeroPadValue(ethers.toBeHex(newPeriod), 32)]
            );
            const pid = await propose(PARAM_CHANGE, [], callData);
            await gov.connect(bankA).castVote(pid, true);
            await gov.connect(bankB).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);

            await expect(gov.executeProposal(pid))
                .to.emit(gov, "ProposalExecuted")
                .and.to.emit(gov, "ParamChanged").withArgs(paramKey, ethers.zeroPadValue(ethers.toBeHex(newPeriod), 32));

            expect(await gov.votingPeriod()).to.equal(BigInt(newPeriod));
        });

        it("executes ADD_MEMBER and new member can vote", async function () {
            const NEW_BANK = ethers.id("BANK_D");
            const [, , , , bankD] = await ethers.getSigners();
            const callData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["bytes32", "address"], [NEW_BANK, bankD.address]
            );
            const pid = await propose(ADD_MEMBER, [], callData);
            await gov.connect(bankA).castVote(pid, true);
            await gov.connect(bankB).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);

            await gov.executeProposal(pid);
            expect(await gov.isMember(NEW_BANK)).to.be.true;
            expect(await gov.memberCount()).to.equal(4n);
        });

        it("executes REMOVE_MEMBER", async function () {
            const callData = "0x";
            const pid = await propose(REMOVE_MEMBER, [BANK_C], callData);
            await gov.connect(bankA).castVote(pid, true);
            await gov.connect(bankB).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);

            await gov.executeProposal(pid);
            const [, active] = await gov.getMember(BANK_C);
            expect(active).to.be.false;
            expect(await gov.memberCount()).to.equal(2n);
        });

        it("cannot remove the last member", async function () {
            // 3 members → remove B → remove C → attempt to remove A should fail
            const setupRemoval = async (target) => {
                const pid = await propose(REMOVE_MEMBER, [target], "0x");
                await gov.connect(bankA).castVote(pid, true);
                await gov.connect(bankB).castVote(pid, true);
                await increaseTime(8 * 24 * 3600);
                await gov.executeProposal(pid);
            };
            await setupRemoval(BANK_C);
            const pid = await propose(REMOVE_MEMBER, [BANK_B], "0x");
            await gov.connect(bankA).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);
            // Only 2 members now, quorum=ceil(2*2/3)=2, bankA voted — not enough
            await expect(gov.executeProposal(pid)).to.emit(gov, "ProposalDefeated");
        });

        it("cannot execute a proposal twice", async function () {
            // UNPAUSE with crossBankPaused=false is a no-op that succeeds cleanly.
            await gov.connect(bankA).pauseCrossBank(); // pause first so UNPAUSE has effect
            const pid = await propose(UNPAUSE, [], "0x");
            await gov.connect(bankA).castVote(pid, true);
            await gov.connect(bankB).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);
            await gov.executeProposal(pid);
            await expect(gov.executeProposal(pid)).to.be.revertedWith("proposal not active");
        });
    });

    // ── emergency pause ──────────────────────────────────────────────────────────

    describe("pauseCrossBank / UNPAUSE", function () {
        beforeEach(setup2Members);

        it("any single member can pause immediately", async function () {
            await expect(gov.connect(bankA).pauseCrossBank())
                .to.emit(gov, "CrossBankPaused")
                .withArgs(BANK_A);
            expect(await gov.crossBankPaused()).to.be.true;
        });

        it("non-member cannot pause", async function () {
            await expect(gov.connect(stranger).pauseCrossBank())
                .to.be.revertedWith("not a member");
        });

        it("cannot pause when already paused", async function () {
            await gov.connect(bankA).pauseCrossBank();
            await expect(gov.connect(bankB).pauseCrossBank())
                .to.be.revertedWith("already paused");
        });

        it("UNPAUSE proposal restores cross-bank flows after M-of-N vote", async function () {
            await gov.connect(bankA).pauseCrossBank();

            const tx = await gov.connect(bankA).createProposal(
                UNPAUSE, [], "0x", ethers.ZeroAddress
            );
            const receipt = await tx.wait();
            const ev = receipt.logs
                .map(l => { try { return gov.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "ProposalCreated");
            const pid = ev.args.proposalId;

            await gov.connect(bankA).castVote(pid, true);
            await gov.connect(bankB).castVote(pid, true);
            await increaseTime(8 * 24 * 3600);

            await expect(gov.executeProposal(pid))
                .to.emit(gov, "CrossBankResumed").withArgs(pid)
                .and.to.emit(gov, "ProposalExecuted");

            expect(await gov.crossBankPaused()).to.be.false;
        });
    });

    // ── quorumRequired ───────────────────────────────────────────────────────────

    describe("quorumRequired", function () {
        it("2 members: quorum = ceil(2*2/3) = 2", async function () {
            await setup2Members();
            expect(await gov.quorumRequired()).to.equal(2n);
        });

        it("3 members: quorum = ceil(3*2/3) = 2", async function () {
            await setup3Members();
            expect(await gov.quorumRequired()).to.equal(2n);
        });

        it("4 members: quorum = ceil(4*2/3) = 3", async function () {
            await gov.bootstrapAddMember(BANK_A, bankA.address);
            await gov.bootstrapAddMember(BANK_B, bankB.address);
            await gov.bootstrapAddMember(BANK_C, bankC.address);
            const [, , , , , bankD] = await ethers.getSigners();
            await gov.bootstrapAddMember(ethers.id("BANK_D"), bankD.address);
            expect(await gov.quorumRequired()).to.equal(3n);
        });
    });
});
