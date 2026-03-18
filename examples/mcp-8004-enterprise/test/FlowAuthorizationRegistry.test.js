const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("FlowAuthorizationRegistry", function () {
    let flowAuth;
    let identity, traceLog, reviewerOracle, approverOracle;
    let owner, agent, requester, stranger;
    let agentId;

    // Capability hashes — must match the contract constants
    const CAP_REVIEW_CODE = ethers.id("review_code");
    const CAP_APPROVE_PR  = ethers.id("approve_pr");

    beforeEach(async function () {
        [owner, agent, requester, stranger] = await ethers.getSigners();

        const FlowAuth = await ethers.getContractFactory("FlowAuthorizationRegistry");
        flowAuth = await FlowAuth.deploy();
        await flowAuth.waitForDeployment();

        // Deploy supporting contracts for oracle integration tests
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

        await identity.connect(agent)["register(string,(string,bytes)[],address)"](
            "ipfs://alice", [], await reviewerOracle.getAddress()
        );
        agentId = 0n;
    });

    // ── capability constants ──────────────────────────────────────────────────────

    describe("capability constants", function () {
        it("CAP_REVIEW_CODE equals keccak256('review_code')", async function () {
            expect(await flowAuth.CAP_REVIEW_CODE()).to.equal(CAP_REVIEW_CODE);
        });

        it("CAP_APPROVE_PR equals keccak256('approve_pr')", async function () {
            expect(await flowAuth.CAP_APPROVE_PR()).to.equal(CAP_APPROVE_PR);
        });
    });

    // ── createFlow ───────────────────────────────────────────────────────────────

    describe("createFlow", function () {
        it("emits FlowCreated with initiator and timestamp", async function () {
            const traceId = ethers.id("flow-1");
            const tx = await flowAuth.connect(owner).createFlow(traceId, [
                { agentId: 0n, capabilities: [CAP_REVIEW_CODE] },
            ]);
            const receipt = await tx.wait();
            const event = receipt.logs
                .map(l => { try { return flowAuth.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "FlowCreated");

            expect(event.args.traceId).to.equal(traceId);
            expect(event.args.initiator).to.equal(owner.address);
        });

        it("emits AgentCapabilityGranted for each (agentId, capability) pair", async function () {
            const traceId = ethers.id("flow-events");
            const tx = await flowAuth.createFlow(traceId, [
                { agentId: 0n, capabilities: [CAP_REVIEW_CODE, CAP_APPROVE_PR] },
                { agentId: 1n, capabilities: [CAP_APPROVE_PR] },
            ]);
            const receipt = await tx.wait();
            const events = receipt.logs
                .map(l => { try { return flowAuth.interface.parseLog(l); } catch { return null; } })
                .filter(e => e?.name === "AgentCapabilityGranted");

            expect(events).to.have.lengthOf(3);
        });

        it("reverts with zero traceId", async function () {
            await expect(
                flowAuth.createFlow(ethers.ZeroHash, [])
            ).to.be.revertedWith("zero traceId");
        });

        it("reverts when the same traceId is registered twice (immutable)", async function () {
            const traceId = ethers.id("immutable-flow");
            await flowAuth.createFlow(traceId, []);
            await expect(
                flowAuth.createFlow(traceId, [])
            ).to.be.revertedWith("flow already exists");
        });

        it("accepts an empty authorizations list", async function () {
            const traceId = ethers.id("empty-flow");
            await expect(flowAuth.createFlow(traceId, [])).to.not.be.reverted;
        });
    });

    // ── flowExists ───────────────────────────────────────────────────────────────

    describe("flowExists", function () {
        it("returns false before a flow is created", async function () {
            expect(await flowAuth.flowExists(ethers.id("no-such-flow"))).to.be.false;
        });

        it("returns true after a flow is created", async function () {
            const traceId = ethers.id("exists-test");
            await flowAuth.createFlow(traceId, []);
            expect(await flowAuth.flowExists(traceId)).to.be.true;
        });
    });

    // ── isAuthorized ─────────────────────────────────────────────────────────────

    describe("isAuthorized", function () {
        it("returns true when no flow policy exists (backward compatibility)", async function () {
            const unknownTrace = ethers.id("unregistered-trace");
            expect(await flowAuth.isAuthorized(unknownTrace, 99n, CAP_REVIEW_CODE)).to.be.true;
        });

        it("returns true for an authorized (agentId, capability) pair", async function () {
            const traceId = ethers.id("auth-test-1");
            await flowAuth.createFlow(traceId, [
                { agentId: 0n, capabilities: [CAP_REVIEW_CODE] },
            ]);
            expect(await flowAuth.isAuthorized(traceId, 0n, CAP_REVIEW_CODE)).to.be.true;
        });

        it("returns false for a capability not granted to the agent", async function () {
            const traceId = ethers.id("auth-test-2");
            await flowAuth.createFlow(traceId, [
                { agentId: 0n, capabilities: [CAP_REVIEW_CODE] },
            ]);
            // Agent 0 has review_code but NOT approve_pr
            expect(await flowAuth.isAuthorized(traceId, 0n, CAP_APPROVE_PR)).to.be.false;
        });

        it("returns false for an agentId not listed in the flow policy", async function () {
            const traceId = ethers.id("auth-test-3");
            await flowAuth.createFlow(traceId, [
                { agentId: 0n, capabilities: [CAP_REVIEW_CODE] },
            ]);
            // Agent 99 was never added
            expect(await flowAuth.isAuthorized(traceId, 99n, CAP_REVIEW_CODE)).to.be.false;
        });

        it("supports multiple agents with different capability sets", async function () {
            const traceId = ethers.id("multi-agent");
            await flowAuth.createFlow(traceId, [
                { agentId: 0n, capabilities: [CAP_REVIEW_CODE] },
                { agentId: 1n, capabilities: [CAP_APPROVE_PR] },
            ]);
            expect(await flowAuth.isAuthorized(traceId, 0n, CAP_REVIEW_CODE)).to.be.true;
            expect(await flowAuth.isAuthorized(traceId, 0n, CAP_APPROVE_PR)).to.be.false;
            expect(await flowAuth.isAuthorized(traceId, 1n, CAP_APPROVE_PR)).to.be.true;
            expect(await flowAuth.isAuthorized(traceId, 1n, CAP_REVIEW_CODE)).to.be.false;
        });
    });

    // ── authorizeAgentForFlow (P2a bilateral consent) ─────────────────────────

    describe("authorizeAgentForFlow", function () {
        it("reverts when flow does not exist", async function () {
            await expect(
                flowAuth.connect(owner).authorizeAgentForFlow(
                    ethers.id("no-such-flow"), 0n, [CAP_REVIEW_CODE]
                )
            ).to.be.revertedWith("flow does not exist");
        });

        it("grants capabilities without governance enforcement when not configured", async function () {
            const traceId = ethers.id("bilateral-1");
            await flowAuth.createFlow(traceId, []);

            await expect(
                flowAuth.connect(stranger).authorizeAgentForFlow(traceId, 0n, [CAP_REVIEW_CODE])
            ).to.not.be.reverted;

            expect(await flowAuth.isAuthorized(traceId, 0n, CAP_REVIEW_CODE)).to.be.true;
        });

        it("emits AgentCapabilityGranted and AgentFlowConsentGranted", async function () {
            const traceId = ethers.id("bilateral-events");
            await flowAuth.createFlow(traceId, []);
            const tx = await flowAuth.connect(stranger).authorizeAgentForFlow(
                traceId, 0n, [CAP_REVIEW_CODE]
            );
            await expect(tx).to.emit(flowAuth, "AgentCapabilityGranted");
            await expect(tx).to.emit(flowAuth, "AgentFlowConsentGranted");
        });

        describe("with governance contracts configured", function () {
            // Use signers[5] and signers[6] to avoid any collision with outer scope.
            let participant, BANK_A_PID, BANK_B_PID, bankAMinter, bankBMinter, unrelated;

            beforeEach(async function () {
                const allSigners = await ethers.getSigners();
                bankAMinter = allSigners[5];
                bankBMinter = allSigners[6];
                unrelated   = allSigners[7];

                const PR = await ethers.getContractFactory("ParticipantRegistry");
                participant = await PR.deploy(owner.address);
                await participant.waitForDeployment();

                BANK_A_PID = ethers.id("BILATERAL_BANK_A");
                BANK_B_PID = ethers.id("BILATERAL_BANK_B");

                await participant.registerParticipant(BANK_A_PID, 0, 0, [bankAMinter.address], [], []);
                await participant.registerParticipant(BANK_B_PID, 0, 0, [bankBMinter.address], [], []);

                // Wire ParticipantRegistry into IdentityRegistry so participantId is
                // auto-recorded on register().
                await identity.connect(owner).setParticipantRegistry(
                    await participant.getAddress()
                );

                // Configure bilateral consent on the flow registry.
                await flowAuth.connect(owner).setGovernanceContracts(
                    await identity.getAddress(),
                    await participant.getAddress()
                );
            });

            it("non-minter is blocked", async function () {
                const traceId = ethers.id("bilateral-gate");
                await flowAuth.createFlow(traceId, []);
                // unrelated is not a registered minter in the participant registry
                await expect(
                    flowAuth.connect(unrelated).authorizeAgentForFlow(traceId, 0n, [CAP_REVIEW_CODE])
                ).to.be.revertedWith("caller is not a registered minter");
            });

            it("minter from wrong institution is blocked", async function () {
                // bankAMinter registers an agent → participantId=BANK_A is auto-recorded.
                await identity.connect(bankAMinter)["register(string,(string,bytes)[],address)"](
                    "ipfs://bank-a-agent",
                    [],
                    await reviewerOracle.getAddress()
                );
                // agentId=1 (agentId=0 was registered in outer beforeEach by `agent`)
                const bankAAgentId = 1n;

                const traceId = ethers.id("bilateral-wrong-bank");
                await flowAuth.createFlow(traceId, []);

                // bankBMinter tries to authorize an agent that belongs to BANK_A
                await expect(
                    flowAuth.connect(bankBMinter).authorizeAgentForFlow(
                        traceId, bankAAgentId, [CAP_REVIEW_CODE]
                    )
                ).to.be.revertedWith("caller not from agent's institution");
            });

            it("minter from the correct institution is allowed", async function () {
                await identity.connect(bankAMinter)["register(string,(string,bytes)[],address)"](
                    "ipfs://bank-a-agent2",
                    [],
                    await reviewerOracle.getAddress()
                );
                const bankAAgentId = 1n;

                const traceId = ethers.id("bilateral-correct");
                await flowAuth.createFlow(traceId, []);

                await expect(
                    flowAuth.connect(bankAMinter).authorizeAgentForFlow(
                        traceId, bankAAgentId, [CAP_REVIEW_CODE]
                    )
                ).to.not.be.reverted;

                expect(await flowAuth.isAuthorized(traceId, bankAAgentId, CAP_REVIEW_CODE)).to.be.true;
            });

            it("agent without participantId (registered before ParticipantRegistry was wired) passes check", async function () {
                // agentId=0 was registered in the outer beforeEach before participant registry
                // was wired in. Its participantId metadata will be empty (length 0), so the
                // institution check is skipped — opt-in per-agent.
                const traceId = ethers.id("bilateral-no-pid");
                await flowAuth.createFlow(traceId, []);

                await expect(
                    flowAuth.connect(bankAMinter).authorizeAgentForFlow(traceId, 0n, [CAP_REVIEW_CODE])
                ).to.not.be.reverted;
            });
        });
    });

    // ── getFlowPolicy ────────────────────────────────────────────────────────────

    describe("getFlowPolicy", function () {
        it("returns initiator, timestamp, and ordered agentId list", async function () {
            const traceId = ethers.id("policy-query");
            const tx = await flowAuth.connect(stranger).createFlow(traceId, [
                { agentId: 5n, capabilities: [CAP_REVIEW_CODE] },
                { agentId: 7n, capabilities: [CAP_APPROVE_PR] },
            ]);
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt.blockNumber);

            const [initiator, createdAt, agentIds] = await flowAuth.getFlowPolicy(traceId);
            expect(initiator).to.equal(stranger.address);
            expect(createdAt).to.equal(BigInt(block.timestamp));
            expect(agentIds.map(id => id.toString())).to.deep.equal(["5", "7"]);
        });

        it("returns zero address and empty list for an unregistered traceId", async function () {
            const [initiator, createdAt, agentIds] = await flowAuth.getFlowPolicy(ethers.id("ghost"));
            expect(initiator).to.equal(ethers.ZeroAddress);
            expect(agentIds).to.be.empty;
        });
    });
});
