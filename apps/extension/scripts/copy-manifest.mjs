import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");
await mkdir(destination, { recursive: true });
for (const asset of ["manifest.json", "src/popup.html", "src/approval.html", "src/icon.svg"]) {
  await cp(resolve(root, asset), resolve(destination, asset.split("/").pop()));
}
console.log(`Copied extension assets to ${destination}`);
