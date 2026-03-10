const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("IdentityRegistryUpgradeable", function () {
    let identity;
    let owner, user1, user2, newWallet;

    beforeEach(async function () {
        [owner, user1, user2, newWallet] = await ethers.getSigners();
        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();
    });

    // ── register() ──────────────────────────────────────────────────────────────

    describe("register()", function () {
        it("mints token 0 and sets agentWallet to msg.sender", async function () {
            await identity.connect(user1)["register()"]();
            expect(await identity.ownerOf(0)).to.equal(user1.address);
            expect(await identity.getAgentWallet(0)).to.equal(user1.address);
        });

        it("increments token ids for successive registrations", async function () {
            await identity.connect(user1)["register()"]();
            await identity.connect(user2)["register()"]();
            expect(await identity.ownerOf(1)).to.equal(user2.address);
        });

        it("emits Registered", async function () {
            await expect(identity.connect(user1)["register()"]())
                .to.emit(identity, "Registered")
                .withArgs(0n, "", user1.address);
        });
    });

    // ── register(string) ────────────────────────────────────────────────────────

    describe("register(string)", function () {
        it("stores the token URI", async function () {
            await identity.connect(user1)["register(string)"]("ipfs://agent-card");
            expect(await identity.tokenURI(0)).to.equal("ipfs://agent-card");
        });
    });

    // ── register(string, MetadataEntry[], address) ───────────────────────────────

    describe("register(string,MetadataEntry[],address)", function () {
        it("binds the oracle address", async function () {
            const oracle = user2.address;
            await identity.connect(user1)["register(string,(string,bytes)[],address)"](
                "ipfs://agent", [], oracle
            );
            expect(await identity.getOracleAddress(0)).to.equal(oracle);
        });

        it("rejects address(0) as oracle", async function () {
            await expect(
                identity.connect(user1)["register(string,(string,bytes)[],address)"](
                    "ipfs://agent", [], ethers.ZeroAddress
                )
            ).to.be.revertedWith("ERC8004: zero oracle address");
        });

        it("rejects reserved key agentWallet in metadata array", async function () {
            await expect(
                identity.connect(user1)["register(string,(string,bytes)[],address)"](
                    "ipfs://agent",
                    [{ metadataKey: "agentWallet", metadataValue: "0x" }],
                    user2.address
                )
            ).to.be.revertedWith("reserved key: agentWallet");
        });

        it("rejects reserved key oracleAddress in metadata array", async function () {
            await expect(
                identity.connect(user1)["register(string,(string,bytes)[],address)"](
                    "ipfs://agent",
                    [{ metadataKey: "oracleAddress", metadataValue: "0x" }],
                    user2.address
                )
            ).to.be.revertedWith("reserved key: oracleAddress");
        });
    });

    // ── setMetadata / getMetadata ────────────────────────────────────────────────

    describe("setMetadata / getMetadata", function () {
        beforeEach(async function () {
            await identity.connect(user1)["register(string)"]("ipfs://test");
        });

        it("stores and retrieves arbitrary metadata", async function () {
            const value = ethers.toUtf8Bytes("hello world");
            await identity.connect(user1).setMetadata(0, "custom-key", value);
            const stored = await identity.getMetadata(0, "custom-key");
            expect(ethers.toUtf8String(stored)).to.equal("hello world");
        });

        it("rejects reserved key agentWallet via setMetadata", async function () {
            await expect(
                identity.connect(user1).setMetadata(0, "agentWallet", "0x")
            ).to.be.revertedWith("reserved key: agentWallet");
        });

        it("rejects setMetadata from non-owner", async function () {
            await expect(
                identity.connect(user2).setMetadata(0, "custom", "0x")
            ).to.be.revertedWith("Not authorized");
        });
    });

    // ── setOracleAddress ─────────────────────────────────────────────────────────

    describe("setOracleAddress", function () {
        beforeEach(async function () {
            await identity.connect(user1)["register()"]();
        });

        it("owner can bind an oracle address", async function () {
            await identity.connect(user1).setOracleAddress(0, user2.address);
            expect(await identity.getOracleAddress(0)).to.equal(user2.address);
        });

        it("non-owner cannot bind an oracle address", async function () {
            await expect(
                identity.connect(user2).setOracleAddress(0, user2.address)
            ).to.be.revertedWith("Not authorized");
        });
    });

    // ── setAgentWallet (AgentWalletSetParams) ────────────────────────────────────

    describe("setAgentWallet", function () {
        let agentId, deadline, domain, types;

        beforeEach(async function () {
            await identity.connect(user1)["register(string)"]("ipfs://test");
            agentId = 0n;
            const latest = await ethers.provider.getBlock("latest");
            deadline = BigInt(latest.timestamp) + 60n; // within 5-minute MAX_DEADLINE_DELAY

            domain = {
                name:              "ERC8004IdentityRegistry",
                version:           "1",
                chainId:           (await ethers.provider.getNetwork()).chainId,
                verifyingContract: await identity.getAddress(),
            };

            types = {
                AgentWalletSet: [
                    { name: "agentId",   type: "uint256" },
                    { name: "newWallet", type: "address" },
                    { name: "owner",     type: "address" },
                    { name: "deadline",  type: "uint256" },
                ],
            };
        });

        it("updates agentWallet when signed by the new wallet (EOA)", async function () {
            const sig = await newWallet.signTypedData(domain, types, {
                agentId, newWallet: newWallet.address, owner: user1.address, deadline,
            });

            await identity.connect(user1).setAgentWallet({
                agentId, newWallet: newWallet.address, deadline, signature: sig,
            });

            expect(await identity.getAgentWallet(0)).to.equal(newWallet.address);
        });

        it("reverts when deadline has passed", async function () {
            const past = deadline - 120n; // in the past relative to current block
            const sig = await newWallet.signTypedData(domain, types, {
                agentId, newWallet: newWallet.address, owner: user1.address, deadline: past,
            });

            await expect(
                identity.connect(user1).setAgentWallet({
                    agentId, newWallet: newWallet.address, deadline: past, signature: sig,
                })
            ).to.be.revertedWith("expired");
        });

        it("reverts when deadline is beyond MAX_DEADLINE_DELAY (5 min)", async function () {
            const farFuture = deadline + 3600n; // 1 hour from now — exceeds 5-minute cap
            const sig = await newWallet.signTypedData(domain, types, {
                agentId, newWallet: newWallet.address, owner: user1.address, deadline: farFuture,
            });

            await expect(
                identity.connect(user1).setAgentWallet({
                    agentId, newWallet: newWallet.address, deadline: farFuture, signature: sig,
                })
            ).to.be.revertedWith("deadline too far");
        });

        it("reverts when signed by the wrong key", async function () {
            // user2 signs instead of newWallet
            const sig = await user2.signTypedData(domain, types, {
                agentId, newWallet: newWallet.address, owner: user1.address, deadline,
            });

            await expect(
                identity.connect(user1).setAgentWallet({
                    agentId, newWallet: newWallet.address, deadline, signature: sig,
                })
            ).to.be.revertedWith("invalid wallet sig");
        });

        it("reverts when called by a non-owner", async function () {
            const sig = await newWallet.signTypedData(domain, types, {
                agentId, newWallet: newWallet.address, owner: user1.address, deadline,
            });

            await expect(
                identity.connect(user2).setAgentWallet({
                    agentId, newWallet: newWallet.address, deadline, signature: sig,
                })
            ).to.be.revertedWith("Not authorized");
        });
    });

    // ── transfer clears reserved fields ──────────────────────────────────────────

    describe("transfer clears agentWallet and oracleAddress", function () {
        it("zeroes both reserved fields on token transfer", async function () {
            await identity.connect(user1)["register(string,(string,bytes)[],address)"](
                "ipfs://agent", [], user2.address
            );

            expect(await identity.getAgentWallet(0)).to.equal(user1.address);
            expect(await identity.getOracleAddress(0)).to.equal(user2.address);

            await identity.connect(user1).transferFrom(user1.address, user2.address, 0);

            expect(await identity.getAgentWallet(0)).to.equal(ethers.ZeroAddress);
            expect(await identity.getOracleAddress(0)).to.equal(ethers.ZeroAddress);
        });
    });
});
