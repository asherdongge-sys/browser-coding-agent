import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");
await mkdir(destination, { recursive: true });

for (const asset of ["manifest.json", "src/popup.html", "src/approval.html", "src/agent.html", "src/icon.svg"]) {
  await cp(resolve(root, asset), resolve(destination, asset.split("/").pop()));
}

const bridgeSource = resolve(destination, "chatgpt-bridge.js");
const bridge = await readFile(bridgeSource, "utf8");
const classicBridge = bridge.replace(/(^|\n)export\s*\{\s*\};?\s*$/m, "\n");
await writeFile(bridgeSource, classicBridge, "utf8");

const agentBridgeSource = resolve(destination, "agent-bridge.js");
const agentBridge = await readFile(agentBridgeSource, "utf8");
const classicAgentBridge = agentBridge.replace(/(^|\n)export\s*\{\s*\};?\s*$/m, "\n");
await writeFile(agentBridgeSource, classicAgentBridge, "utf8");

console.log(`Copied extension assets to ${destination}`);
