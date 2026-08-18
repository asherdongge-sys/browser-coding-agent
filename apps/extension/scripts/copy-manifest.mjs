import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "manifest.json");
const destination = resolve(root, "dist", "manifest.json");

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination);
console.log(`Copied manifest to ${destination}`);
