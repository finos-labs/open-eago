const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("ParticipantRegistry", function () {
    let registry;
    let identity;
    let owner, bankMinter, bankApprover, bankSenior, clientMinter, stranger;

    const BANK_ID   = ethers.keccak256(ethers.toUtf8Bytes("ACME_BANK"));
    const CLIENT_ID = ethers.keccak256(ethers.toUtf8Bytes("ACME_HEDGE_FUND"));

    const ParticipantType = { BANK: 0n, CLIENT: 1n };
    const DeploymentTier  = { BANK_INTERNAL: 0n, BANK_EXTERNAL: 1n, CLIENT_EXTERNAL: 2n };

    beforeEach(async function () {
        [owner, bankMinter, bankApprover, bankSenior, clientMinter, stranger] = await ethers.getSigners();

        const Registry = await ethers.getContractFactory("ParticipantRegistry");
        registry = await Registry.deploy(owner.address);
        await registry.waitForDeployment();
    });

    // ── registerParticipant ───────────────────────────────────────────────────────

    describe("registerParticipant()", function () {
        it("registers a BANK participant and emits events", async function () {
            await expect(
                registry.registerParticipant(
                    BANK_ID, ParticipantType.BANK, DeploymentTier.BANK_EXTERNAL,
                    [bankMinter.address], [bankApprover.address], [bankSenior.address]
                )
            )
                .to.emit(registry, "ParticipantRegistered").withArgs(BANK_ID, ParticipantType.BANK, DeploymentTier.BANK_EXTERNAL)
                .and.to.emit(registry, "MinterAdded").withArgs(BANK_ID, bankMinter.address)
                .and.to.emit(registry, "ApproverAdded").withArgs(BANK_ID, bankApprover.address)
                .and.to.emit(registry, "SeniorApproverAdded").withArgs(BANK_ID, bankSenior.address);
        });

        it("registers a CLIENT participant", async function () {
            await registry.registerParticipant(
                CLIENT_ID, ParticipantType.CLIENT, DeploymentTier.CLIENT_EXTERNAL,
                [clientMinter.address], [], []
            );
            const p = await registry.getParticipant(CLIENT_ID);
            expect(p.participantType).to.equal(ParticipantType.CLIENT);
            expect(p.defaultAgentTier).to.equal(DeploymentTier.CLIENT_EXTERNAL);
            expect(p.active).to.be.true;
        });

        it("reverts on zero participantId", async function () {
            await expect(
                registry.registerParticipant(ethers.ZeroHash, 0, 0, [], [], [])
            ).to.be.revertedWith("zero participantId");
        });

        it("reverts if already registered", async function () {
            await registry.registerParticipant(BANK_ID, 0, 0, [], [], []);
            await expect(
                registry.registerParticipant(BANK_ID, 0, 0, [], [], [])
            ).to.be.revertedWith("already registered");
        });

        it("reverts for non-owner", async function () {
            await expect(
                registry.connect(stranger).registerParticipant(BANK_ID, 0, 0, [], [], [])
            ).to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
        });
    });

    // ── isApprovedMinter / getMinterParticipantId ─────────────────────────────────

    describe("minter checks", function () {
        beforeEach(async function () {
            await registry.registerParticipant(
                BANK_ID, ParticipantType.BANK, DeploymentTier.BANK_EXTERNAL,
                [bankMinter.address], [], []
            );
        });

        it("returns true for a registered minter", async function () {
            expect(await registry.isApprovedMinter(bankMinter.address)).to.be.true;
        });

        it("returns false for an unregistered address", async function () {
            expect(await registry.isApprovedMinter(stranger.address)).to.be.false;
        });

        it("returns the correct participantId for a minter", async function () {
            expect(await registry.getMinterParticipantId(bankMinter.address)).to.equal(BANK_ID);
        });

        it("returns false after minter is removed", async function () {
            await registry.removeMinter(BANK_ID, bankMinter.address);
            expect(await registry.isApprovedMinter(bankMinter.address)).to.be.false;
        });

        it("reverts adding a minter to an inactive participant", async function () {
            await registry.deactivateParticipant(BANK_ID);
            await expect(
                registry.addMinter(BANK_ID, stranger.address)
            ).to.be.revertedWith("participant not active");
        });

        it("reverts adding the same minter address twice", async function () {
            await expect(
                registry.addMinter(BANK_ID, bankMinter.address)
            ).to.be.revertedWith("already a minter");
        });

        it("reverts adding a minter already registered for another participant", async function () {
            await registry.registerParticipant(CLIENT_ID, 1, 2, [], [], []);
            await expect(
                registry.addMinter(CLIENT_ID, bankMinter.address)
            ).to.be.revertedWith("address is minter for another participant");
        });
    });

    // ── isApprover / isSeniorApprover ────────────────────────────────────────────

    describe("approver checks", function () {
        beforeEach(async function () {
            await registry.registerParticipant(
                BANK_ID, ParticipantType.BANK, DeploymentTier.BANK_EXTERNAL,
                [], [bankApprover.address], [bankSenior.address]
            );
        });

        it("returns true for a registered approver", async function () {
            expect(await registry.isApprover(bankApprover.address)).to.be.true;
        });

        it("returns true for a registered senior approver", async function () {
            expect(await registry.isSeniorApprover(bankSenior.address)).to.be.true;
        });

        it("returns false for stranger", async function () {
            expect(await registry.isApprover(stranger.address)).to.be.false;
            expect(await registry.isSeniorApprover(stranger.address)).to.be.false;
        });

        it("returns false after approver is removed", async function () {
            await registry.removeApprover(BANK_ID, bankApprover.address);
            expect(await registry.isApprover(bankApprover.address)).to.be.false;
        });

        it("returns false after senior approver is removed", async function () {
            await registry.removeSeniorApprover(BANK_ID, bankSenior.address);
            expect(await registry.isSeniorApprover(bankSenior.address)).to.be.false;
        });
    });

    // ── deactivateParticipant ────────────────────────────────────────────────────

    describe("deactivateParticipant()", function () {
        beforeEach(async function () {
            await registry.registerParticipant(
                BANK_ID, ParticipantType.BANK, DeploymentTier.BANK_EXTERNAL,
                [bankMinter.address], [bankApprover.address], []
            );
        });

        it("blocks minting after deactivation", async function () {
            await registry.deactivateParticipant(BANK_ID);
            expect(await registry.isApprovedMinter(bankMinter.address)).to.be.false;
        });

        it("blocks approvals after deactivation", async function () {
            await registry.deactivateParticipant(BANK_ID);
            expect(await registry.isApprover(bankApprover.address)).to.be.false;
        });

        it("emits ParticipantDeactivated", async function () {
            await expect(registry.deactivateParticipant(BANK_ID))
                .to.emit(registry, "ParticipantDeactivated").withArgs(BANK_ID);
        });

        it("reverts deactivating an already inactive participant", async function () {
            await registry.deactivateParticipant(BANK_ID);
            await expect(registry.deactivateParticipant(BANK_ID))
                .to.be.revertedWith("not active");
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("IdentityRegistryUpgradeable — ParticipantRegistry minting gate", function () {
    let identity;
    let registry;
    let owner, bankMinter, stranger;

    const BANK_ID = ethers.keccak256(ethers.toUtf8Bytes("ACME_BANK"));

    beforeEach(async function () {
        [owner, bankMinter, stranger] = await ethers.getSigners();

        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        const Registry = await ethers.getContractFactory("ParticipantRegistry");
        registry = await Registry.deploy(owner.address);
        await registry.waitForDeployment();

        await registry.registerParticipant(
            BANK_ID, 0, 1, [bankMinter.address], [], []
        );
    });

    it("allows unrestricted minting when no registry is configured", async function () {
        await expect(identity.connect(stranger)["register()"]()).not.to.be.reverted;
    });

    it("blocks non-participant minters after registry is configured", async function () {
        await identity.setParticipantRegistry(await registry.getAddress());
        await expect(
            identity.connect(stranger)["register()"]()
        ).to.be.revertedWith("ERC8004: minter not registered participant");
    });

    it("allows registered minter to mint", async function () {
        await identity.setParticipantRegistry(await registry.getAddress());
        await expect(identity.connect(bankMinter)["register()"]()).not.to.be.reverted;
    });

    it("records participantId on the minted agent", async function () {
        await identity.setParticipantRegistry(await registry.getAddress());
        await identity.connect(bankMinter)["register()"]();
        expect(await identity.getParticipantId(0)).to.equal(BANK_ID);
    });

    it("clears participantId on transfer", async function () {
        await identity.setParticipantRegistry(await registry.getAddress());
        await identity.connect(bankMinter)["register()"]();

        await identity.connect(bankMinter).transferFrom(bankMinter.address, stranger.address, 0);
        expect(await identity.getParticipantId(0)).to.equal(ethers.ZeroHash);
    });

    it("emits ParticipantRegistrySet", async function () {
        await expect(identity.setParticipantRegistry(await registry.getAddress()))
            .to.emit(identity, "ParticipantRegistrySet")
            .withArgs(await registry.getAddress(), owner.address);
    });

    it("blocks minting after participant is deactivated", async function () {
        await identity.setParticipantRegistry(await registry.getAddress());
        await registry.deactivateParticipant(BANK_ID);
        await expect(
            identity.connect(bankMinter)["register()"]()
        ).to.be.revertedWith("ERC8004: minter not registered participant");
    });

    it("getParticipantId returns zero for agents minted before registry was set", async function () {
        await identity.connect(stranger)["register()"]();
        await identity.setParticipantRegistry(await registry.getAddress());
        expect(await identity.getParticipantId(0)).to.equal(ethers.ZeroHash);
    });

    it("reverts setParticipantRegistry from non-owner", async function () {
        await expect(
            identity.connect(stranger).setParticipantRegistry(await registry.getAddress())
        ).to.be.revertedWithCustomError(identity, "OwnableUnauthorizedAccount");
    });

    it("reserved key participantId is blocked via setMetadata", async function () {
        await identity.connect(stranger)["register()"]();
        await expect(
            identity.connect(stranger).setMetadata(0, "participantId", "0x1234")
        ).to.be.revertedWith("reserved key: participantId");
    });
});
