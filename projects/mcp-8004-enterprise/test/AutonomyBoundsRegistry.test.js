const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("AutonomyBoundsRegistry", function () {
    let bounds;
    let owner, monitor, stranger;

    const TOOL_REVIEW_PR  = ethers.id("review_pr");
    const TOOL_APPROVE_PR = ethers.id("approve_pr");
    const AGENT_ID = 1n;

    beforeEach(async function () {
        [owner, monitor, stranger] = await ethers.getSigners();

        const Bounds = await ethers.getContractFactory("AutonomyBoundsRegistry");
        bounds = await Bounds.deploy();
        await bounds.waitForDeployment();
    });

    // ── constructor ───────────────────────────────────────────────────────────

    describe("constructor", function () {
        it("sets owner to deployer", async function () {
            expect(await bounds.owner()).to.equal(owner.address);
        });

        it("leaves monitor unset", async function () {
            expect(await bounds.monitor()).to.equal(ethers.ZeroAddress);
        });
    });

    // ── setMonitor ────────────────────────────────────────────────────────────

    describe("setMonitor", function () {
        it("emits MonitorSet and stores the address", async function () {
            await expect(bounds.connect(owner).setMonitor(monitor.address))
                .to.emit(bounds, "MonitorSet").withArgs(monitor.address);
            expect(await bounds.monitor()).to.equal(monitor.address);
        });

        it("reverts from non-owner", async function () {
            await expect(bounds.connect(stranger).setMonitor(monitor.address))
                .to.be.revertedWith("not owner");
        });
    });

    // ── isToolEnabled default behaviour ───────────────────────────────────────

    describe("isToolEnabled — default", function () {
        it("returns true for a tool that has never been disabled", async function () {
            expect(await bounds.isToolEnabled(AGENT_ID, TOOL_REVIEW_PR)).to.be.true;
        });

        it("returns true for any agentId / toolHash that has never been set", async function () {
            expect(await bounds.isToolEnabled(999n, ethers.id("unknown_tool"))).to.be.true;
        });
    });

    // ── disableTool ───────────────────────────────────────────────────────────

    describe("disableTool", function () {
        beforeEach(async function () {
            await bounds.connect(owner).setMonitor(monitor.address);
        });

        it("emits ToolDisabled with correct args", async function () {
            const tx = await bounds.connect(monitor).disableTool(AGENT_ID, TOOL_REVIEW_PR, "anomaly: error rate 30%");
            const receipt = await tx.wait();
            const event = receipt.logs
                .map(l => { try { return bounds.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "ToolDisabled");
            expect(event.args.agentId).to.equal(AGENT_ID);
            expect(event.args.toolHash).to.equal(TOOL_REVIEW_PR);
            expect(event.args.reason).to.equal("anomaly: error rate 30%");
            expect(event.args.timestamp).to.be.gt(0n);
        });

        it("isToolEnabled returns false after disableTool", async function () {
            await bounds.connect(monitor).disableTool(AGENT_ID, TOOL_REVIEW_PR, "burst");
            expect(await bounds.isToolEnabled(AGENT_ID, TOOL_REVIEW_PR)).to.be.false;
        });

        it("does not affect other agents or tools", async function () {
            await bounds.connect(monitor).disableTool(AGENT_ID, TOOL_REVIEW_PR, "test");
            expect(await bounds.isToolEnabled(AGENT_ID, TOOL_APPROVE_PR)).to.be.true;
            expect(await bounds.isToolEnabled(2n, TOOL_REVIEW_PR)).to.be.true;
        });

        it("reverts from non-monitor", async function () {
            await expect(
                bounds.connect(stranger).disableTool(AGENT_ID, TOOL_REVIEW_PR, "hack")
            ).to.be.revertedWith("not monitor");
        });

        it("reverts from owner when owner is not the monitor", async function () {
            await expect(
                bounds.connect(owner).disableTool(AGENT_ID, TOOL_REVIEW_PR, "hack")
            ).to.be.revertedWith("not monitor");
        });
    });

    // ── enableTool ────────────────────────────────────────────────────────────

    describe("enableTool", function () {
        beforeEach(async function () {
            await bounds.connect(owner).setMonitor(monitor.address);
            await bounds.connect(monitor).disableTool(AGENT_ID, TOOL_REVIEW_PR, "anomaly");
        });

        it("emits ToolEnabled with correct args", async function () {
            const tx = await bounds.connect(monitor).enableTool(AGENT_ID, TOOL_REVIEW_PR);
            const receipt = await tx.wait();
            const event = receipt.logs
                .map(l => { try { return bounds.interface.parseLog(l); } catch { return null; } })
                .find(e => e?.name === "ToolEnabled");
            expect(event.args.agentId).to.equal(AGENT_ID);
            expect(event.args.toolHash).to.equal(TOOL_REVIEW_PR);
            expect(event.args.timestamp).to.be.gt(0n);
        });

        it("isToolEnabled returns true after enableTool", async function () {
            await bounds.connect(monitor).enableTool(AGENT_ID, TOOL_REVIEW_PR);
            expect(await bounds.isToolEnabled(AGENT_ID, TOOL_REVIEW_PR)).to.be.true;
        });

        it("clears disabledReason and disabledAt after re-enable", async function () {
            await bounds.connect(monitor).enableTool(AGENT_ID, TOOL_REVIEW_PR);
            const [enabled, reason, disabledAt] = await bounds.getToolState(AGENT_ID, TOOL_REVIEW_PR);
            expect(enabled).to.be.true;
            expect(reason).to.equal("");
            expect(disabledAt).to.equal(0n);
        });

        it("reverts from non-monitor", async function () {
            await expect(bounds.connect(stranger).enableTool(AGENT_ID, TOOL_REVIEW_PR))
                .to.be.revertedWith("not monitor");
        });
    });

    // ── getToolState ──────────────────────────────────────────────────────────

    describe("getToolState", function () {
        beforeEach(async function () {
            await bounds.connect(owner).setMonitor(monitor.address);
        });

        it("returns (true, '', 0) for a tool never disabled", async function () {
            const [enabled, reason, disabledAt] = await bounds.getToolState(AGENT_ID, TOOL_REVIEW_PR);
            expect(enabled).to.be.true;
            expect(reason).to.equal("");
            expect(disabledAt).to.equal(0n);
        });

        it("returns correct state after disableTool", async function () {
            await bounds.connect(monitor).disableTool(AGENT_ID, TOOL_REVIEW_PR, "test reason");
            const [enabled, reason, disabledAt] = await bounds.getToolState(AGENT_ID, TOOL_REVIEW_PR);
            expect(enabled).to.be.false;
            expect(reason).to.equal("test reason");
            expect(disabledAt).to.be.gt(0n);
        });
    });
});
