import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { McpStdioClient } from "@browser-coding-agent/mcp";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { getGitHubConnection } from "./github-oauth.js";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const githubServer = resolve(runtimeRoot, "github-mcp/dist/server.js");

const browser = new PlaywrightBrowserProvider();
let github: McpStdioClient | undefined;
let githubTools: readonly any[] = [];
let githubAccessToken = "";

const browserTools = [
  { name: "browser.run_task", description: "Run a natural-language browser task in a background Playwright tab for an existing Agent.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, goal: { type: "string" } }, required: ["agentId", "goal"] } },
  { name: "agent.list", description: "List Browser Coding Agent browser sessions.", inputSchema: { type: "object", properties: {} } },
  { name: "agent.create", description: "Create an Agent with its own ChatGPT conversation/tab.", inputSchema: { type: "object", properties: { title: { type: "string" }, prompt: { type: "string" } }, required: ["title"] } },
  { name: "agent.send", description: "Send a normal conversation message to an Agent's ChatGPT session.", inputSchema: { type: "object", properties: { agentId: { type: "string" }, text: { type: "string" } }, required: ["agentId", "text"] } },
] as const;

async function ensureGitHubClient(): Promise<void> {
  const connection = await getGitHubConnection();
  if (!connection) {
    if (github) { await github.stop(); github = undefined; githubTools = []; githubAccessToken = ""; }
    return;
  }
  if (github && githubAccessToken === connection.accessToken) return;
  await github?.stop();
  github = new McpStdioClient(process.execPath, [githubServer], { GITHUB_ACCESS_TOKEN: connection.accessToken });
  await github.start();
  githubTools = await github.listTools();
  githubAccessToken = connection.accessToken;
}

async function start() { await browser.start(); await ensureGitHubClient(); }

async function call(name: string, args: any): Promise<any> {
  if (name.startsWith("github.")) { await ensureGitHubClient(); if (!github) throw new Error("GitHub is not connected. Connect GitHub in Browser Coding Agent settings first."); return github.callTool(name, args); }
  if (name === "browser.run_task") { await browser.runTask(String(args.agentId), String(args.goal)); return { ok: true }; }
  if (name === "agent.list") return { agents: await browser.listAgents() };
  if (name === "agent.create") return { agent: await browser.createAgent(String(args.title ?? "Agent"), String(args.prompt ?? "")) };
  if (name === "agent.send") { await browser.sendMessage(String(args.agentId), String(args.text)); return { ok: true }; }
  throw new Error(`Unknown MCP tool: ${name}`);
}

const tools = async () => { await ensureGitHubClient(); return [...browserTools, ...githubTools]; };

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let request: any; try { request = JSON.parse(line); } catch { return; }
  if (request.method === "notifications/initialized") return;
  try {
    if (request.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "browser-coding-agent-runtime", version: "0.1.0" } } }) + "\n"); return; }
    if (request.method === "tools/list") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: await tools() } }) + "\n"); return; }
    if (request.method === "tools/call") { const result = await call(request.params?.name, request.params?.arguments ?? {}); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] } }) + "\n"); return; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } }) + "\n"); }
});

async function shutdown() { try { await browser.stop(); } finally { await github?.stop(); } }
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
void start().catch((error) => { process.stderr.write(`[MCP runtime] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exit(1); });