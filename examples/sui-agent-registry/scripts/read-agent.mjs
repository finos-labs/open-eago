/**
 * read-agent.mjs — Read a registered agent from the SUI Agentic Registry.
 *
 * Usage:
 *   node read-agent.mjs [agentId]        # default: 0
 *   node read-agent.mjs 0
 */

import { SuiClient } from "@mysten/sui/client";

const IDENTITY_ID = "0xa2f954548badde685bc80a9ccefaf87cde671a4cf8805b214743e6a141c4f67e";
const RPC_URL     = "https://fullnode.testnet.sui.io:443";
const NETWORK     = "testnet";

const agentId = Number(process.argv[2] ?? 0);
const client  = new SuiClient({ url: RPC_URL });

console.log("=".repeat(60));
console.log(`Reading agent ID ${agentId} from ${NETWORK}`);
console.log("=".repeat(60));

// ─── Registry stats ───────────────────────────────────────────────────────────

const registryObj = await client.getObject({
  id: IDENTITY_ID,
  options: { showContent: true },
});

const regFields = registryObj.data?.content?.fields ?? {};
const tableId   = regFields.agents?.fields?.id?.id;
console.log(`Registry total agents: ${regFields.counter ?? "unknown"}`);
console.log();

// ─── Agent entry ──────────────────────────────────────────────────────────────
// AgentEntry lives inside an ObjectTable; look it up on the table's inner ID.

let entryResp;
try {
  entryResp = await client.getDynamicFieldObject({
    parentId: tableId,
    name: { type: "u64", value: agentId.toString() },
  });
} catch {
  console.error(`Agent ID ${agentId} not found.`);
  process.exit(1);
}

if (!entryResp.data) {
  console.error(`Agent ID ${agentId} not found.`);
  process.exit(1);
}

const ef = entryResp.data.content?.fields ?? {};
const globalId = `sui:${NETWORK}:${IDENTITY_ID}:${agentId}`;

console.log("─".repeat(60));
console.log("Agent Entry");
console.log("─".repeat(60));
console.log(`  globalId  : ${globalId}`);
console.log(`  agentId   : ${ef.agent_id}`);
console.log(`  owner     : ${ef.owner}`);
console.log(`  agentUri  : ${ef.agent_uri}`);
console.log(`  active    : ${ef.active}`);
console.log(`  createdAt : ${new Date(Number(ef.created_at)).toISOString()}`);
console.log(`  updatedAt : ${new Date(Number(ef.updated_at)).toISOString()}`);
console.log();

// ─── Fetch the agent.json from the URI ───────────────────────────────────────

const uri = ef.agent_uri;
if (uri?.startsWith("http")) {
  console.log(`► Fetching agent card from ${uri} ...`);
  try {
    const resp = await fetch(uri, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const card = await resp.json();
      console.log();
      console.log("Agent Card (agent.json):");
      console.log(JSON.stringify(card, null, 2));
    } else {
      console.log(`  HTTP ${resp.status} — could not fetch agent card`);
    }
  } catch (err) {
    console.log(`  Could not fetch agent card: ${err.message}`);
  }
}
