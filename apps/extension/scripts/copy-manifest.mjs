import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");
await mkdir(destination, { recursive: true });

for (const asset of ["manifest.json", "src/popup.html", "src/approval.html", "src/icon.svg"]) {
  await cp(resolve(root, asset), resolve(destination, asset.split("/").pop()));
}

// chatgpt-bridge.ts is intentionally compiled as a TypeScript module so it has
// its own type-checking scope. Chrome content_scripts, however, load classic
// scripts rather than ES modules, so remove TypeScript's empty module marker
// from the emitted file before copying it to the extension root.
const bridgeSource = resolve(destination, "chatgpt-bridge.js");
const bridgeTarget = resolve(destination, "chatgpt-bridge.js");
const bridge = await readFile(bridgeSource, "utf8");
const classicBridge = bridge.replace(/(^|\n)export\s*\{\s*\};?\s*$/m, "\n");
await writeFile(bridgeTarget, classicBridge, "utf8");

console.log(`Copied extension assets to ${destination}`);
