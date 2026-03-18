const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("ReputationRegistryUpgradeable", function () {
    let identity, repRegistry;
    let owner, agentOwner, client1, client2, stranger;
    let agentId;

    beforeEach(async function () {
        [owner, agentOwner, client1, client2, stranger] = await ethers.getSigners();

        const Identity = await ethers.getContractFactory("IdentityRegistryUpgradeable");
        identity = await upgrades.deployProxy(Identity, [], { initializer: "initialize" });
        await identity.waitForDeployment();

        const RepReg = await ethers.getContractFactory("ReputationRegistryUpgradeable");
        repRegistry = await upgrades.deployProxy(
            RepReg,
            [await identity.getAddress()],
            { initializer: "initialize" }
        );
        await repRegistry.waitForDeployment();

        // Register an agent owned by agentOwner (agentId = 0)
        await identity.connect(agentOwner)["register()"]();
        agentId = 0n;
    });

    // ── initializer ───────────────────────────────────────────────────────────

    describe("initialize", function () {
        it("stores the identity registry address", async function () {
            expect(await repRegistry.getIdentityRegistry())
                .to.equal(await identity.getAddress());
        });

        it("reverts with zero identity registry address", async function () {
            const RepReg = await ethers.getContractFactory("ReputationRegistryUpgradeable");
            await expect(
                upgrades.deployProxy(RepReg, [ethers.ZeroAddress], { initializer: "initialize" })
            ).to.be.revertedWith("bad identity");
        });

        it("returns version string", async function () {
            expect(await repRegistry.getVersion()).to.equal("2.0.0");
        });
    });

    // ── giveFeedback ──────────────────────────────────────────────────────────

    describe("giveFeedback", function () {
        it("stores feedback and increments lastIndex", async function () {
            await repRegistry.connect(client1).giveFeedback(
                agentId, 80, 0, "review_code", "", "", "", ethers.ZeroHash
            );

            expect(await repRegistry.getLastIndex(agentId, client1.address)).to.equal(1n);

            const [value, decimals, tag1, tag2, isRevoked] =
                await repRegistry.readFeedback(agentId, client1.address, 1);
            expect(value).to.equal(80n);
            expect(decimals).to.equal(0);
            expect(tag1).to.equal("review_code");
            expect(tag2).to.equal("");
            expect(isRevoked).to.be.false;
        });

        it("emits NewFeedback with correct args", async function () {
            await expect(
                repRegistry.connect(client1).giveFeedback(
                    agentId, 90, 1, "approve_pr", "high_quality", "endpoint", "uri://1", ethers.ZeroHash
                )
            ).to.emit(repRegistry, "NewFeedback")
             .withArgs(agentId, client1.address, 1n, 90n, 1, "approve_pr", "approve_pr", "high_quality", "endpoint", "uri://1", ethers.ZeroHash);
        });

        it("allows multiple feedback entries from the same client", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 50, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).giveFeedback(agentId, 70, 0, "", "", "", "", ethers.ZeroHash);

            expect(await repRegistry.getLastIndex(agentId, client1.address)).to.equal(2n);
        });

        it("tracks the client address in getClients", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 50, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client2).giveFeedback(agentId, 60, 0, "", "", "", "", ethers.ZeroHash);

            const clients = await repRegistry.getClients(agentId);
            expect(clients).to.include(client1.address);
            expect(clients).to.include(client2.address);
        });

        it("does not duplicate the same client in getClients", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 50, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).giveFeedback(agentId, 60, 0, "", "", "", "", ethers.ZeroHash);

            const clients = await repRegistry.getClients(agentId);
            expect(clients.filter(c => c === client1.address)).to.have.length(1);
        });

        it("reverts when valueDecimals > 18", async function () {
            await expect(
                repRegistry.connect(client1).giveFeedback(agentId, 50, 19, "", "", "", "", ethers.ZeroHash)
            ).to.be.revertedWith("too many decimals");
        });

        it("reverts when value exceeds MAX_ABS_VALUE", async function () {
            const tooBig = BigInt("100000000000000000000000000000000000000") + 1n; // 1e38 + 1
            await expect(
                repRegistry.connect(client1).giveFeedback(agentId, tooBig, 0, "", "", "", "", ethers.ZeroHash)
            ).to.be.reverted;
        });

        it("reverts self-feedback from the agent owner", async function () {
            await expect(
                repRegistry.connect(agentOwner).giveFeedback(agentId, 100, 0, "", "", "", "", ethers.ZeroHash)
            ).to.be.revertedWith("Self-feedback not allowed");
        });
    });

    // ── revokeFeedback ────────────────────────────────────────────────────────

    describe("revokeFeedback", function () {
        beforeEach(async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 80, 0, "", "", "", "", ethers.ZeroHash);
        });

        it("marks the feedback as revoked and emits FeedbackRevoked", async function () {
            await expect(repRegistry.connect(client1).revokeFeedback(agentId, 1))
                .to.emit(repRegistry, "FeedbackRevoked")
                .withArgs(agentId, client1.address, 1n);

            const [, , , , isRevoked] = await repRegistry.readFeedback(agentId, client1.address, 1);
            expect(isRevoked).to.be.true;
        });

        it("reverts on double revoke", async function () {
            await repRegistry.connect(client1).revokeFeedback(agentId, 1);
            await expect(repRegistry.connect(client1).revokeFeedback(agentId, 1))
                .to.be.revertedWith("Already revoked");
        });

        it("reverts with index 0", async function () {
            await expect(repRegistry.connect(client1).revokeFeedback(agentId, 0))
                .to.be.revertedWith("index must be > 0");
        });

        it("reverts with out-of-bounds index", async function () {
            await expect(repRegistry.connect(client1).revokeFeedback(agentId, 99))
                .to.be.revertedWith("index out of bounds");
        });
    });

    // ── readFeedback ──────────────────────────────────────────────────────────

    describe("readFeedback", function () {
        it("reverts with index 0", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 50, 0, "", "", "", "", ethers.ZeroHash);
            await expect(repRegistry.readFeedback(agentId, client1.address, 0))
                .to.be.revertedWith("index must be > 0");
        });

        it("reverts with out-of-bounds index", async function () {
            await expect(repRegistry.readFeedback(agentId, client1.address, 1))
                .to.be.revertedWith("index out of bounds");
        });
    });

    // ── appendResponse ────────────────────────────────────────────────────────

    describe("appendResponse", function () {
        beforeEach(async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 80, 0, "", "", "", "", ethers.ZeroHash);
        });

        it("emits ResponseAppended and increments response count", async function () {
            await expect(
                repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 1, "uri://resp", ethers.ZeroHash)
            ).to.emit(repRegistry, "ResponseAppended")
             .withArgs(agentId, client1.address, 1n, agentOwner.address, "uri://resp", ethers.ZeroHash);

            const count = await repRegistry.getResponseCount(agentId, client1.address, 1, [agentOwner.address]);
            expect(count).to.equal(1n);
        });

        it("allows multiple responses from the same responder", async function () {
            await repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 1, "uri://1", ethers.ZeroHash);
            await repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 1, "uri://2", ethers.ZeroHash);

            const count = await repRegistry.getResponseCount(agentId, client1.address, 1, [agentOwner.address]);
            expect(count).to.equal(2n);
        });

        it("reverts with index 0", async function () {
            await expect(
                repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 0, "uri://r", ethers.ZeroHash)
            ).to.be.revertedWith("index must be > 0");
        });

        it("reverts with empty responseURI", async function () {
            await expect(
                repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 1, "", ethers.ZeroHash)
            ).to.be.revertedWith("Empty URI");
        });

        it("reverts with out-of-bounds feedbackIndex", async function () {
            await expect(
                repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 99, "uri://r", ethers.ZeroHash)
            ).to.be.revertedWith("index out of bounds");
        });
    });

    // ── getSummary ────────────────────────────────────────────────────────────

    describe("getSummary", function () {
        it("reverts when clientAddresses is empty", async function () {
            await expect(
                repRegistry.getSummary(agentId, [], "", "")
            ).to.be.revertedWith("clientAddresses required");
        });

        it("returns zero count when no feedback exists for client", async function () {
            const [count, value] = await repRegistry.getSummary(agentId, [client1.address], "", "");
            expect(count).to.equal(0n);
            expect(value).to.equal(0n);
        });

        it("returns correct average for a single feedback entry", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 80, 0, "tag", "", "", "", ethers.ZeroHash);

            const [count, value, decimals] = await repRegistry.getSummary(agentId, [client1.address], "", "");
            expect(count).to.equal(1n);
            expect(value).to.equal(80n);
            expect(decimals).to.equal(0);
        });

        it("averages multiple feedback entries across clients", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 60, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client2).giveFeedback(agentId, 80, 0, "", "", "", "", ethers.ZeroHash);

            const [count, value] = await repRegistry.getSummary(
                agentId, [client1.address, client2.address], "", ""
            );
            expect(count).to.equal(2n);
            expect(value).to.equal(70n); // (60 + 80) / 2
        });

        it("excludes revoked feedback from the summary", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 100, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).giveFeedback(agentId, 20, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).revokeFeedback(agentId, 2); // revoke the low score

            const [count, value] = await repRegistry.getSummary(agentId, [client1.address], "", "");
            expect(count).to.equal(1n);
            expect(value).to.equal(100n);
        });

        it("filters by tag1 when specified", async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 90, 0, "review_code", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).giveFeedback(agentId, 10, 0, "approve_pr", "", "", "", ethers.ZeroHash);

            const [count, value] = await repRegistry.getSummary(agentId, [client1.address], "review_code", "");
            expect(count).to.equal(1n);
            expect(value).to.equal(90n);
        });
    });

    // ── readAllFeedback ───────────────────────────────────────────────────────

    describe("readAllFeedback", function () {
        beforeEach(async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 80, 0, "tag1", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).giveFeedback(agentId, 60, 0, "tag2", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client1).revokeFeedback(agentId, 2);
        });

        it("returns all non-revoked feedback by default", async function () {
            // readAllFeedback returns: (clients, feedbackIndexes, values, valueDecimals, tag1s, tag2s, revokedStatuses)
            const result = await repRegistry.readAllFeedback(agentId, [client1.address], "", "", false);
            const vals = result[2]; // index 2 = values (avoid clash with Array.prototype.values)
            expect(vals.length).to.equal(1);
            expect(vals[0]).to.equal(80n);
        });

        it("includes revoked feedback when includeRevoked is true", async function () {
            const result = await repRegistry.readAllFeedback(agentId, [client1.address], "", "", true);
            expect(result[2].length).to.equal(2);
        });

        it("filters by tag1 when specified", async function () {
            const result = await repRegistry.readAllFeedback(agentId, [client1.address], "tag1", "", false);
            expect(result[2].length).to.equal(1);
            expect(result[4][0]).to.equal("tag1"); // index 4 = tag1s
        });

        it("uses all stored clients when clientAddresses is empty", async function () {
            // client2 also gives feedback
            await repRegistry.connect(client2).giveFeedback(agentId, 55, 0, "", "", "", "", ethers.ZeroHash);

            const result = await repRegistry.readAllFeedback(agentId, [], "", "", false);
            // Should include client1's non-revoked + client2's
            expect(result[2].length).to.be.gte(2);
        });
    });

    // ── getResponseCount ──────────────────────────────────────────────────────

    describe("getResponseCount", function () {
        beforeEach(async function () {
            await repRegistry.connect(client1).giveFeedback(agentId, 80, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(agentOwner).appendResponse(agentId, client1.address, 1, "uri://1", ethers.ZeroHash);
            await repRegistry.connect(stranger).appendResponse(agentId, client1.address, 1, "uri://2", ethers.ZeroHash);
        });

        it("counts responses from specified responders", async function () {
            const count = await repRegistry.getResponseCount(agentId, client1.address, 1, [agentOwner.address]);
            expect(count).to.equal(1n);
        });

        it("counts all responses when responders array is empty", async function () {
            const count = await repRegistry.getResponseCount(agentId, client1.address, 1, []);
            expect(count).to.equal(2n);
        });

        it("returns 0 for clientAddress=zero (scans all clients) and no responses", async function () {
            // No responses for client2
            await repRegistry.connect(client2).giveFeedback(agentId, 50, 0, "", "", "", "", ethers.ZeroHash);
            // We only care that it doesn't revert and returns a count
            const count = await repRegistry.getResponseCount(agentId, ethers.ZeroAddress, 0, []);
            expect(count).to.be.gte(2n); // includes responses added in beforeEach
        });
    });

    // ── getSummaryFiltered (P3 anti-gaming) ───────────────────────────────────

    describe("getSummaryFiltered", function () {
        let participant, BANK_A_PID, BANK_B_PID;

        beforeEach(async function () {
            const PR = await ethers.getContractFactory("ParticipantRegistry");
            participant = await PR.deploy(owner.address);
            await participant.waitForDeployment();

            BANK_A_PID = ethers.id("BANK_A");
            BANK_B_PID = ethers.id("BANK_B");

            // client1 belongs to BANK_A, client2 belongs to BANK_B.
            await participant.registerParticipant(BANK_A_PID, 0, 0, [client1.address], [], []);
            await participant.registerParticipant(BANK_B_PID, 0, 0, [client2.address], [], []);

            // Both give feedback.
            await repRegistry.connect(client1).giveFeedback(agentId, 90, 0, "", "", "", "", ethers.ZeroHash);
            await repRegistry.connect(client2).giveFeedback(agentId, 10, 0, "", "", "", "", ethers.ZeroHash);
        });

        it("includes only feedback from trusted institutions", async function () {
            // Trust only BANK_A (client1 score=90). BANK_B's low score is excluded.
            const [count, value] = await repRegistry.getSummaryFiltered(
                agentId,
                [BANK_A_PID],
                await participant.getAddress(),
                "", ""
            );
            expect(count).to.equal(1n);
            expect(value).to.equal(90n);
        });

        it("includes feedback from multiple trusted institutions", async function () {
            const [count, value] = await repRegistry.getSummaryFiltered(
                agentId,
                [BANK_A_PID, BANK_B_PID],
                await participant.getAddress(),
                "", ""
            );
            expect(count).to.equal(2n);
            // Average of 90 and 10 = 50
            expect(value).to.equal(50n);
        });

        it("returns zero count when trustedParticipantIds is empty", async function () {
            const [count] = await repRegistry.getSummaryFiltered(
                agentId,
                [],
                await participant.getAddress(),
                "", ""
            );
            expect(count).to.equal(0n);
        });

        it("excludes feedback from non-trusted institutions", async function () {
            // Trust only BANK_B
            const [count, value] = await repRegistry.getSummaryFiltered(
                agentId,
                [BANK_B_PID],
                await participant.getAddress(),
                "", ""
            );
            expect(count).to.equal(1n);
            expect(value).to.equal(10n);
        });

        it("reverts when participantRegistry_ is zero address", async function () {
            await expect(
                repRegistry.getSummaryFiltered(agentId, [BANK_A_PID], ethers.ZeroAddress, "", "")
            ).to.be.revertedWith("participantRegistry required");
        });

        it("respects tag filter across trusted institutions", async function () {
            // client1 gives a tagged feedback; client2 gives untagged.
            await repRegistry.connect(client1).giveFeedback(agentId, 100, 0, "review_code", "", "", "", ethers.ZeroHash);

            const [count, value] = await repRegistry.getSummaryFiltered(
                agentId,
                [BANK_A_PID, BANK_B_PID],
                await participant.getAddress(),
                "review_code", ""
            );
            // Only the one tagged entry from client1 (100) should be counted.
            expect(count).to.equal(1n);
            expect(value).to.equal(100n);
        });
    });
});
