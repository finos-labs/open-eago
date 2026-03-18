const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const PromptRegistry = await ethers.getContractFactory("PromptRegistry");
  const registry = await PromptRegistry.deploy();
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log("PromptRegistry deployed to:", address);

  // Example: register a placeholder prompt hash so the bridge has something to verify against.
  // In practice this is done by registry_bridge.py in CI/CD.
  const promptId = ethers.keccak256(ethers.toUtf8Bytes("aml-review-agent"));
  const version = "v1.0.0";
  const contentHash = ethers.keccak256(ethers.toUtf8Bytes("placeholder — replace via bridge"));

  const tx = await registry.register(promptId, version, contentHash);
  await tx.wait();
  console.log(`Registered placeholder for aml-review-agent@${version}`);

  console.log("\nExport for bridge/.env:");
  console.log(`PROMPT_REGISTRY_ADDRESS=${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
