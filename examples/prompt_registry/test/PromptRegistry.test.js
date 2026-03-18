const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PromptRegistry", function () {
  let registry, owner, other;
  const PROMPT_ID = ethers.keccak256(ethers.toUtf8Bytes("aml-review-agent"));
  const VERSION   = "abc123";
  const HASH      = ethers.keccak256(ethers.toUtf8Bytes("some prompt content"));

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("PromptRegistry");
    registry = await Factory.deploy();
  });

  it("registers a prompt hash and emits event", async function () {
    await expect(registry.register(PROMPT_ID, VERSION, HASH))
      .to.emit(registry, "PromptRegistered")
      .withArgs(PROMPT_ID, VERSION, HASH, owner.address);
  });

  it("getHash returns the stored hash after registration", async function () {
    await registry.register(PROMPT_ID, VERSION, HASH);
    expect(await registry.getHash(PROMPT_ID, VERSION)).to.equal(HASH);
  });

  it("getHash returns zero for unknown prompt", async function () {
    expect(await registry.getHash(PROMPT_ID, VERSION)).to.equal(ethers.ZeroHash);
  });

  it("verify returns true for correct hash", async function () {
    await registry.register(PROMPT_ID, VERSION, HASH);
    expect(await registry.verify(PROMPT_ID, VERSION, HASH)).to.be.true;
  });

  it("verify returns false for wrong hash", async function () {
    await registry.register(PROMPT_ID, VERSION, HASH);
    const wrong = ethers.keccak256(ethers.toUtf8Bytes("tampered"));
    expect(await registry.verify(PROMPT_ID, VERSION, wrong)).to.be.false;
  });

  it("verify returns false for unregistered prompt", async function () {
    expect(await registry.verify(PROMPT_ID, VERSION, HASH)).to.be.false;
  });

  it("rejects register from non-owner", async function () {
    await expect(
      registry.connect(other).register(PROMPT_ID, VERSION, HASH)
    ).to.be.revertedWith("PromptRegistry: not owner");
  });

  it("rejects zero content hash", async function () {
    await expect(
      registry.register(PROMPT_ID, VERSION, ethers.ZeroHash)
    ).to.be.revertedWith("PromptRegistry: zero hash");
  });

  it("allows overwriting a registered hash", async function () {
    await registry.register(PROMPT_ID, VERSION, HASH);
    const updated = ethers.keccak256(ethers.toUtf8Bytes("updated content"));
    await registry.register(PROMPT_ID, VERSION, updated);
    expect(await registry.getHash(PROMPT_ID, VERSION)).to.equal(updated);
  });

  it("treats same promptId + different version as distinct entries", async function () {
    const HASH2 = ethers.keccak256(ethers.toUtf8Bytes("v2 content"));
    await registry.register(PROMPT_ID, VERSION, HASH);
    await registry.register(PROMPT_ID, "v2.0.0", HASH2);
    expect(await registry.getHash(PROMPT_ID, VERSION)).to.equal(HASH);
    expect(await registry.getHash(PROMPT_ID, "v2.0.0")).to.equal(HASH2);
  });

  it("transfers ownership", async function () {
    await registry.transferOwnership(other.address);
    expect(await registry.owner()).to.equal(other.address);
    await expect(
      registry.register(PROMPT_ID, VERSION, HASH)
    ).to.be.revertedWith("PromptRegistry: not owner");
    await registry.connect(other).register(PROMPT_ID, VERSION, HASH);
    expect(await registry.getHash(PROMPT_ID, VERSION)).to.equal(HASH);
  });
});
