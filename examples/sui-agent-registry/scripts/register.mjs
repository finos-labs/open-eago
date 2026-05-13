/**
 * register.mjs — Register a test agent on the SUI Agentic Registry.
 *
 * Uses `sui client call` (SUI CLI) to sign and submit the transaction with
 * the currently active wallet, then reads the result back via JSON-RPC.
 *
 * Usage:
 *   node register.mjs [agentUri] [--agent-file path/to/agent.json]
 *   node register.mjs http://localhost:8080/agent.json --agent-file agent.json
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { SuiClient } from "@mysten/sui/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGE_ID  = "0xffc720800328035a338bed002d1a2d0ab62cd5d25c40c5d88034d15e446c5d85";
const IDENTITY_ID = "0xa2f954548badde685bc80a9ccefaf87cde671a4cf8805b214743e6a141c4f67e";
const RPC_URL     = "https://fullnode.testnet.sui.io:443";
const NETWORK     = "testnet";
const CLOCK_ID    = "0x6";

const rawArgs = process.argv.slice(2);
const agentFileFlag = rawArgs.indexOf("--agent-file");
const agentFile = agentFileFlag !== -1 ? rawArgs[agentFileFlag + 1] : null;
const positional = rawArgs.filter((a, i) => !a.startsWith("--") && rawArgs[i - 1] !== "--agent-file");
const agentUri = positional[0] ?? "http://localhost:8080/agent.json";

// ─── 1. Submit registration transaction via CLI ───────────────────────────────

console.log("=".repeat(60));
console.log("SUI Agentic Registry — Agent Registration");
console.log("=".repeat(60));
console.log(`Package  : ${PACKAGE_ID}`);
console.log(`Registry : ${IDENTITY_ID}`);
console.log(`Agent URI: ${agentUri}`);
console.log();

console.log("► Submitting transaction (sui client call)...");

let txDigest;
let agentCapId;

try {
  const cmd = [
    "sui client call",
    `--package ${PACKAGE_ID}`,
    "--module identity_registry",
    "--function register",
    `--args ${IDENTITY_ID} "${agentUri}" ${CLOCK_ID}`,
    "--json",
  ].join(" \\\n  ");

  const raw = execSync(
    `sui client call \
      --package ${PACKAGE_ID} \
      --module identity_registry \
      --function register \
      --args ${IDENTITY_ID} "${agentUri}" ${CLOCK_ID} \
      --json`,
    { encoding: "utf8" }
  );

  const result = JSON.parse(raw);

  // Extract digest
  txDigest = result.digest;
  console.log(`✓ Transaction submitted: ${txDigest}`);

  // Find the created AgentCap object
  const created = (result.objectChanges ?? []).filter(
    (o) => o.type === "created"
  );

  const capObj = created.find((o) =>
    o.objectType?.includes("::identity_registry::AgentCap")
  );
  const entryObj = created.find((o) =>
    o.objectType?.includes("::identity_registry::AgentEntry")
  );

  if (capObj) {
    agentCapId = capObj.objectId;
    console.log(`✓ AgentCap created  : ${agentCapId}`);
  }
  if (entryObj) {
    console.log(`✓ AgentEntry created: ${entryObj.objectId}`);
  }
} catch (err) {
  console.error("✗ Transaction failed:", err.message);
  process.exit(1);
}

// ─── 2. Read back the registered agent from chain ────────────────────────────

console.log();
console.log("► Reading registered agent from chain...");

const client = new SuiClient({ url: RPC_URL });

// Get registry object to find the ObjectTable inner ID and counter
const registryObj = await client.getObject({
  id: IDENTITY_ID,
  options: { showContent: true },
});

const regFields = registryObj.data?.content?.fields ?? {};
const counter   = Number(regFields.counter ?? 0);
const agentId   = counter - 1; // last registered
const tableId   = regFields.agents?.fields?.id?.id;

console.log(`✓ Registry counter  : ${counter} (agent ID = ${agentId})`);

// Fetch the AgentEntry via dynamic object field on the ObjectTable inner ID
try {
  const entryResp = await client.getDynamicFieldObject({
    parentId: tableId,
    name: { type: "u64", value: agentId.toString() },
  });

  const ef = entryResp.data?.content?.fields ?? {};
  const globalId = `sui:${NETWORK}:${IDENTITY_ID}:${agentId}`;

  console.log();
  console.log("─".repeat(60));
  console.log("Registered Agent");
  console.log("─".repeat(60));
  console.log(`  globalId  : ${globalId}`);
  console.log(`  agentId   : ${ef.agent_id}`);
  console.log(`  owner     : ${ef.owner}`);
  console.log(`  agentUri  : ${ef.agent_uri}`);
  console.log(`  active    : ${ef.active}`);
  console.log(`  createdAt : ${new Date(Number(ef.created_at)).toISOString()}`);
  console.log();
  console.log("─".repeat(60));
  console.log("Save your AgentCap — needed to update or deregister:");
  console.log(`  AgentCap ID: ${agentCapId}`);
  console.log("─".repeat(60));
  // ─── 3. Write globalId back to local agent.json ────────────────────────────

  if (agentFile) {
    try {
      const card = JSON.parse(readFileSync(agentFile, "utf8"));
      const registryRef = `sui:${NETWORK}:${IDENTITY_ID}`;
      card.agentId = globalId;
      const regs = card.registrations ?? [];
      const existing = regs.find((r) => r.agentRegistry?.startsWith(registryRef));
      if (existing) {
        existing.agentId = globalId;
        existing.agentRegistry = registryRef;
      } else {
        regs.push({ agentId: globalId, agentRegistry: registryRef });
      }
      card.registrations = regs;
      writeFileSync(agentFile, JSON.stringify(card, null, 2) + "\n");
      console.log(`✓ Updated ${agentFile} with agentId: ${globalId}`);
    } catch (writeErr) {
      console.error(`✗ Could not update ${agentFile}:`, writeErr.message);
    }
  }} catch (err) {
  console.error("Could not read agent entry:", err.message);
}
