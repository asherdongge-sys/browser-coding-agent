import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, "dist");

await mkdir(destination, { recursive: true });
await cp(resolve(root, "manifest.json"), resolve(destination, "manifest.json"));
await cp(resolve(root, "src", "popup.html"), resolve(destination, "popup.html"));
console.log(`Copied extension assets to ${destination}`);
