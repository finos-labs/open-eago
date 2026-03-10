const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ExecutionTraceLog", function () {
    let log;
    let owner, oracle, stranger;

    const TRACE = ethers.id("trace-1");

    beforeEach(async function () {
        [owner, oracle, stranger] = await ethers.getSigners();

        const Log = await ethers.getContractFactory("ExecutionTraceLog");
        log = await Log.deploy();
        await log.waitForDeployment();
    });

    // ── recordHop ─────────────────────────────────────────────────────────────

    describe("recordHop", function () {
        it("stores the hop with correct fields", async function () {
            await log.connect(oracle).recordHop(TRACE, 7n, "reviewRequested");

            const hops = await log.getTrace(TRACE);
            expect(hops).to.have.length(1);
            expect(hops[0].oracle).to.equal(oracle.address);
            expect(hops[0].agentId).to.equal(7n);
            expect(hops[0].action).to.equal("reviewRequested");
            expect(hops[0].timestamp).to.be.gt(0n);
        });

        it("records msg.sender as the oracle address", async function () {
            await log.connect(stranger).recordHop(TRACE, 0n, "hop");
            const hops = await log.getTrace(TRACE);
            expect(hops[0].oracle).to.equal(stranger.address);
        });

        it("emits HopRecorded with correct args", async function () {
            const tx = await log.connect(oracle).recordHop(TRACE, 3n, "reviewFulfilled");
            const receipt = await tx.wait();
            const block = await ethers.provider.getBlock(receipt.blockNumber);
            const event = receipt.logs
                .map(l => { try { return log.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "HopRecorded");
            expect(event.args.traceId).to.equal(TRACE);
            expect(event.args.oracle).to.equal(oracle.address);
            expect(event.args.agentId).to.equal(3n);
            expect(event.args.action).to.equal("reviewFulfilled");
            expect(event.args.timestamp).to.equal(BigInt(block.timestamp));
        });

        it("appends multiple hops in order", async function () {
            await log.connect(oracle).recordHop(TRACE, 0n, "reviewRequested");
            await log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled");
            await log.connect(oracle).recordHop(TRACE, 2n, "approvalRequested");

            const hops = await log.getTrace(TRACE);
            expect(hops).to.have.length(3);
            expect(hops[0].action).to.equal("reviewRequested");
            expect(hops[1].action).to.equal("reviewFulfilled");
            expect(hops[2].action).to.equal("approvalRequested");
        });

        it("maintains independent traces per traceId", async function () {
            const TRACE_B = ethers.id("trace-2");
            await log.connect(oracle).recordHop(TRACE,   0n, "hop-a");
            await log.connect(oracle).recordHop(TRACE_B, 0n, "hop-b");

            expect(await log.getHopCount(TRACE)).to.equal(1n);
            expect(await log.getHopCount(TRACE_B)).to.equal(1n);
            expect((await log.getTrace(TRACE))[0].action).to.equal("hop-a");
            expect((await log.getTrace(TRACE_B))[0].action).to.equal("hop-b");
        });
    });

    // ── getHopCount ───────────────────────────────────────────────────────────

    describe("getHopCount", function () {
        it("returns 0 for a trace with no hops", async function () {
            expect(await log.getHopCount(TRACE)).to.equal(0n);
        });

        it("returns the correct count after hops are added", async function () {
            await log.connect(oracle).recordHop(TRACE, 0n, "a");
            await log.connect(oracle).recordHop(TRACE, 0n, "b");
            expect(await log.getHopCount(TRACE)).to.equal(2n);
        });
    });

    // ── setMaxHops ────────────────────────────────────────────────────────────

    describe("setMaxHops", function () {
        it("emits MaxHopsSet and stores the value", async function () {
            await expect(log.connect(owner).setMaxHops(5))
                .to.emit(log, "MaxHopsSet").withArgs(5n);
            expect(await log.maxHopsPerTrace()).to.equal(5n);
        });

        it("reverts from non-owner", async function () {
            await expect(log.connect(stranger).setMaxHops(5))
                .to.be.revertedWith("not owner");
        });

        it("reverts recordHop when hop count reaches the limit", async function () {
            await log.connect(owner).setMaxHops(2);
            await log.connect(oracle).recordHop(TRACE, 0n, "first");
            await log.connect(oracle).recordHop(TRACE, 0n, "second");

            await expect(log.connect(oracle).recordHop(TRACE, 0n, "third"))
                .to.be.revertedWith("max hops exceeded");
        });

        it("allows exactly maxHopsPerTrace hops without reverting", async function () {
            await log.connect(owner).setMaxHops(3);
            await log.connect(oracle).recordHop(TRACE, 0n, "a");
            await log.connect(oracle).recordHop(TRACE, 0n, "b");
            await log.connect(oracle).recordHop(TRACE, 0n, "c");
            expect(await log.getHopCount(TRACE)).to.equal(3n);
        });

        it("setting max to 0 disables the limit", async function () {
            await log.connect(owner).setMaxHops(1);
            await log.connect(oracle).recordHop(TRACE, 0n, "first");

            // Disable limit
            await log.connect(owner).setMaxHops(0);
            // Should not revert
            await log.connect(oracle).recordHop(TRACE, 0n, "second");
            await log.connect(oracle).recordHop(TRACE, 0n, "third");
            expect(await log.getHopCount(TRACE)).to.equal(3n);
        });
    });

    // ── setLoopDetection ──────────────────────────────────────────────────────

    describe("setLoopDetection", function () {
        it("emits LoopDetectionSet and stores the value", async function () {
            await expect(log.connect(owner).setLoopDetection(true))
                .to.emit(log, "LoopDetectionSet").withArgs(true);
            expect(await log.loopDetectionEnabled()).to.be.true;
        });

        it("reverts from non-owner", async function () {
            await expect(log.connect(stranger).setLoopDetection(true))
                .to.be.revertedWith("not owner");
        });

        it("reverts when the same (oracle, agentId, action) triple is recorded twice", async function () {
            await log.connect(owner).setLoopDetection(true);
            await log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled");

            await expect(log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled"))
                .to.be.revertedWith("loop detected");
        });

        it("allows the same action from a different oracle (not a loop)", async function () {
            await log.connect(owner).setLoopDetection(true);
            await log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled");

            // stranger acts as a different oracle contract — must NOT revert
            await log.connect(stranger).recordHop(TRACE, 1n, "reviewFulfilled");
            expect(await log.getHopCount(TRACE)).to.equal(2n);
        });

        it("allows the same oracle with a different action (not a loop)", async function () {
            await log.connect(owner).setLoopDetection(true);
            await log.connect(oracle).recordHop(TRACE, 1n, "reviewRequested");

            await log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled");
            expect(await log.getHopCount(TRACE)).to.equal(2n);
        });

        it("allows the same oracle and action but different agentId (not a loop)", async function () {
            await log.connect(owner).setLoopDetection(true);
            await log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled");

            await log.connect(oracle).recordHop(TRACE, 2n, "reviewFulfilled");
            expect(await log.getHopCount(TRACE)).to.equal(2n);
        });

        it("does not affect a different traceId", async function () {
            await log.connect(owner).setLoopDetection(true);
            await log.connect(oracle).recordHop(TRACE, 1n, "reviewFulfilled");

            // Same triple but different trace — should NOT revert
            const TRACE_B = ethers.id("trace-b");
            await log.connect(oracle).recordHop(TRACE_B, 1n, "reviewFulfilled");
            expect(await log.getHopCount(TRACE_B)).to.equal(1n);
        });
    });
});

async function latestTimestamp() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
}
