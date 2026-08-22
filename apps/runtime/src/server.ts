import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { RpcMessage, ToolCall, ToolResult } from "@browser-coding-agent/protocol";
import { PermissionManager } from "@browser-coding-agent/permissions";
import { ToolRegistry, WorkspaceManager, createFilesystemTools, createTerminalTools } from "@browser-coding-agent/tools";
import { McpStdioClient } from "@browser-coding-agent/mcp";
import type { BrowserAgentEvent, BrowserProvider } from "./browser-provider.js";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { completeGitHubOAuth, createGitHubAuthorizeUrl, disconnectGitHub, getGitHubConnection, githubOAuthCallbackUrl, githubOAuthStatus } from "./github-oauth.js";

export const DEFAULT_PORT = 4317;
const DASHBOARD_FILE = fileURLToPath(new URL("../web/index.html", import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 3000;
const GITHUB_MCP_SERVER = join(process.cwd(), "apps", "github-mcp", "dist", "server.js");
const DASHBOARD_LAYOUT_STYLE = `<style id="runtime-layout-fix">html,body{height:100%;overflow:hidden}body{min-height:100vh}.sidebar{height:100vh;min-height:0;overflow:hidden}.agents{min-height:0;overflow-y:auto;overflow-x:hidden}.main{height:100vh;min-height:0;overflow:hidden}.top,.composer{flex:none}.messages{min-height:0;overflow-y:auto;overflow-x:hidden}</style>`;

type Role = "extension" | "dashboard" | "unknown";
type WsSocketLike = { terminate(): void; readyState: number; send(data: string): void };
type WsServerLike = { close(callback?: (error?: Error) => void): void };
type PendingApproval = { socket?: WebSocket; call: ToolCall; toolName: string; resolve: (result: ToolResult<unknown>) => void };
const wsSocket = (socket: WebSocket): WsSocketLike => socket as unknown as WsSocketLike;
const wsServerLike = (server: WebSocketServer): WsServerLike => server as unknown as WsServerLike;
function safeSend(socket: WebSocket, message: unknown): void { if (socket.readyState !== WebSocket.OPEN) return; socket.send(typeof message === "string" ? message : JSON.stringify(message)); }
function reply(socket: WebSocket, id: string | number, result?: unknown, error?: { code: number; message: string }): void { safeSend(socket, error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }); }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value.trim(); }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function safeWorkspaceRoot(workspace: WorkspaceManager): string | null { try { return workspace.getRoot(); } catch { return null; } }

export function createRuntimeServer(port = Number(process.env.BROWSER_CODING_AGENT_PORT ?? DEFAULT_PORT)) {
  const workspace = new WorkspaceManager();
  const tools = new ToolRegistry();
  const permissions = new PermissionManager({ defaultDecision: "deny", rules: { read: "allow", write: "ask", execute: "ask", git: "ask" } });
  const pending = new Map<string, PendingApproval>();
  const clients = new Set<WebSocket>();
  const roles = new Map<WebSocket, Role>();
  const sessionAllowed = new Set<string>();
  const configuredProvider = (process.env.BROWSER_PROVIDER ?? "playwright").trim().toLowerCase();
  const providerKind = configuredProvider === "extension" ? "extension" : "playwright";
  let browserProvider: BrowserProvider | undefined;
  let browserStartup: Promise<void> | undefined;
  let browserStartupError: Error | undefined;
  let githubMcp: McpStdioClient | undefined;
  let githubMcpStartup: Promise<void> | undefined;
  let githubMcpTools: readonly { name: string }[] = [];
  let shuttingDown = false;
  const githubInitialization = new Map<string, Promise<void>>();
  for (const tool of [...createFilesystemTools(workspace), ...createTerminalTools(workspace)]) tools.register(tool);
  const safeBroadcast = (message: unknown, role?: Role): void => { for (const client of clients) if (!role || roles.get(client) === role) safeSend(client, message); };
  const emitBrowserEvent = (event: BrowserAgentEvent): void => { if (event.type === "agent.tool.call" || event.type === "agent.tool.result") return; safeBroadcast({ jsonrpc: "2.0", method: "dashboard.event", params: event }, "dashboard"); };
  if (providerKind === "playwright") { browserProvider = new PlaywrightBrowserProvider({ onEvent: emitBrowserEvent }); browserStartup = browserProvider.start().catch((error) => { browserStartupError = error instanceof Error ? error : new Error(String(error)); console.error("[BrowserCodingAgent] Playwright startup failed:", browserStartupError.message); }); }
  const ensureBrowser = async (): Promise<BrowserProvider> => { if (!browserProvider) throw new Error("Playwright browser provider is not enabled"); if (browserStartup) await browserStartup; if (browserStartupError) throw browserStartupError; await browserProvider.start(); return browserProvider; };
  const initializeGitHubApp = async (provider: BrowserProvider, agentId: string): Promise<void> => {
    if (provider.kind !== "playwright") return;
    const managed = provider as unknown as { agents?: Map<string, { page?: import("playwright").Page }>; selectChatGPTApp?: (page: import("playwright").Page, appName: string) => Promise<boolean> };
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const agent = managed.agents?.get(agentId);
      if (!agent?.page || !managed.selectChatGPTApp) { await new Promise((resolve) => setTimeout(resolve, 250)); continue; }
      try {
        const selected = await managed.selectChatGPTApp(agent.page, "GitHub");
        if (selected) { console.log(`[BrowserCodingAgent] GitHub App initialization for ${agentId}: connected`); return; }
      } catch (error) {
        console.warn(`[BrowserCodingAgent] GitHub App initialization retry for ${agentId}:`, error instanceof Error ? error.message : String(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(`[BrowserCodingAgent] GitHub App initialization for ${agentId}: not available`);
  };
  const ensureAgentGitHubInitialization = async (provider: BrowserProvider, agentId: string): Promise<void> => {
    const existing = githubInitialization.get(agentId);
    if (existing) { await existing; return; }
    const task = initializeGitHubApp(provider, agentId).finally(() => { githubInitialization.delete(agentId); });
    githubInitialization.set(agentId, task);
    await task;
  };
  const stopGitHubMcp = async (): Promise<void> => { const client = githubMcp; githubMcp = undefined; githubMcpTools = []; if (client) await client.stop().catch(() => undefined); };
  const ensureGitHubMcp = async (): Promise<McpStdioClient> => { const connection = await getGitHubConnection(); if (!connection?.accessToken) throw new Error("GitHub is not connected. Connect GitHub first."); if (githubMcp) return githubMcp; if (githubMcpStartup) { await githubMcpStartup; if (githubMcp) return githubMcp; } githubMcpStartup = (async () => { const client = new McpStdioClient(process.execPath, [GITHUB_MCP_SERVER], { GITHUB_ACCESS_TOKEN: connection.accessToken }); await client.start(); githubMcpTools = (await client.listTools()).map((tool) => ({ name: tool.name })); githubMcp = client; })().finally(() => { githubMcpStartup = undefined; }); await githubMcpStartup; if (!githubMcp) throw new Error("GitHub MCP failed to start"); return githubMcp; };
  const executeTool = <TArguments = unknown, TResult = unknown>(call: ToolCall<TArguments>, requester?: WebSocket): Promise<ToolResult<TResult>> => { const tool = tools.get(call.tool); if (!tool) return Promise.resolve({ ok: false, error: `Unknown tool: ${call.tool}` }); const decision = sessionAllowed.has(tool.descriptor.name) ? "allow" : permissions.decide({ tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description }); if (decision === "ask") return new Promise<ToolResult<TResult>>((resolveResult) => { const requestId = crypto.randomUUID(); pending.set(requestId, { socket: requester, call, toolName: tool.descriptor.name, resolve: (result) => resolveResult(result as ToolResult<TResult>) }); safeBroadcast({ jsonrpc: "2.0", method: "approval.request", params: { requestId, tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description, arguments: call.arguments } }); }); if (decision !== "allow") return Promise.resolve({ ok: false, error: `Permission ${decision} for ${tool.descriptor.name}` }); return tool.execute(call.arguments).then((result) => result as ToolResult<TResult>); };
  const sendJson = (response: ServerResponse, status: number, body: unknown): void => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
  const httpServer = createServer(async (request, response) => {
    if (shuttingDown) { sendJson(response, 503, { ok: false, error: "Runtime is shutting down" }); return; }
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") { try { const rawHtml = await readFile(DASHBOARD_FILE, "utf8"); const html = rawHtml.includes("</head>") ? rawHtml.replace("</head>", `${DASHBOARD_LAYOUT_STYLE}</head>`) : rawHtml; response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); } catch (error) { response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); response.end(error instanceof Error ? error.message : String(error)); } return; }
    if (requestUrl.pathname === "/api/github/status") { sendJson(response, 200, await githubOAuthStatus(port, await getGitHubConnection())); return; }
    if (requestUrl.pathname === "/api/github/connect") { try { response.writeHead(302, { location: await createGitHubAuthorizeUrl(githubOAuthCallbackUrl(port)), "cache-control": "no-store" }); response.end(); } catch (error) { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); } return; }
    if (requestUrl.pathname === "/api/github/callback") { if (requestUrl.searchParams.get("error")) { const error = requestUrl.searchParams.get("error") ?? "GitHub OAuth failed"; response.writeHead(302, { location: `/?github=error&message=${encodeURIComponent(error)}` }); response.end(); return; } try { const code = requestUrl.searchParams.get("code"); const returnedState = requestUrl.searchParams.get("state"); if (!code || !returnedState) throw new Error("GitHub OAuth callback is missing code or state"); const connection = await completeGitHubOAuth(code, returnedState, githubOAuthCallbackUrl(port)); await stopGitHubMcp(); response.writeHead(302, { location: `/?github=connected&login=${encodeURIComponent(connection.login ?? "")}` }); response.end(); } catch (error) { response.writeHead(302, { location: `/?github=error&message=${encodeURIComponent(error instanceof Error ? error.message : String(error))}` }); response.end(); } return; }
    if (requestUrl.pathname === "/api/github/disconnect" && request.method === "POST") { await stopGitHubMcp(); await disconnectGitHub(); sendJson(response, 200, { ok: true }); return; }
    sendJson(response, 200, { name: "browser-coding-agent", protocol: "0.1", workspace: safeWorkspaceRoot(workspace), clients: clients.size, browserProvider: providerKind, browserStartupError: browserStartupError?.message, githubMcp: { connected: Boolean(await getGitHubConnection()), tools: githubMcpTools.map((tool) => tool.name) } });
  });
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (socket) => { clients.add(socket); roles.set(socket, "unknown"); socket.on("message", async (raw: Buffer) => { let message: RpcMessage; try { message = JSON.parse(raw.toString()) as RpcMessage; } catch { safeSend(socket, { jsonrpc: "2.0", id: "invalid", error: { code: -32700, message: "Invalid JSON" } }); return; } if (!("method" in message) || !("id" in message)) return; const id = message.id; try { const params = asRecord(message.params);
      if (message.method === "runtime.hello") { const role = params.role === "extension" || params.role === "dashboard" ? params.role : "unknown"; roles.set(socket, role); const connection = await getGitHubConnection(); if (role === "dashboard") { const provider = await ensureBrowser(); reply(socket, id, { ok: true, protocol: "0.1", planner: "chatgpt-browser", browserProvider: provider.kind, browserStartupError: browserStartupError?.message, github: { connected: Boolean(connection), login: connection?.login, mcp: "runtime" } }); for (const agent of await provider.listAgents()) safeSend(socket, { jsonrpc: "2.0", method: "dashboard.event", params: { type: "agent.updated", agent } }); } else reply(socket, id, { ok: true, protocol: "0.1", browserProvider: providerKind }); return; }
      if (message.method === "runtime.ping") { reply(socket, id, { ok: true, protocol: "0.1", planner: "chatgpt-browser", browserProvider: providerKind }); return; }
      if (message.method === "agent.list") { const provider = await ensureBrowser(); reply(socket, id, { agents: await provider.listAgents() }); return; }
      if (message.method === "agent.create") { const provider = await ensureBrowser(); const title = typeof params.title === "string" ? params.title : ""; const prompt = typeof params.prompt === "string" ? params.prompt : ""; const agent = await provider.createAgent(title, ""); const initPromise = initializeGitHubApp(provider, agent.id); githubInitialization.set(agent.id, initPromise); void initPromise.finally(() => githubInitialization.delete(agent.id)); if (prompt.trim()) void initPromise.then(() => provider.sendMessage(agent.id, prompt)).catch((error) => safeBroadcast({ jsonrpc: "2.0", method: "dashboard.event", params: { type: "agent.updated", agent: { id: agent.id, status: "failed", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() } } }, "dashboard")); reply(socket, id, { agent }); return; }
      if (message.method === "agent.send") { const provider = await ensureBrowser(); const agentId = requiredString(params.agentId, "agentId"); const text = requiredString(params.text, "text"); void (async () => { try { await ensureAgentGitHubInitialization(provider, agentId); await provider.sendMessage(agentId, text); } catch (error) { safeBroadcast({ jsonrpc: "2.0", method: "dashboard.event", params: { type: "agent.updated", agent: { id: agentId, status: "failed", lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() } } }, "dashboard"); } })(); reply(socket, id, { ok: true, started: true, mode: "chatgpt" }); return; }
      if (message.method === "agent.resume") { const provider = await ensureBrowser(); const agentId = requiredString(params.agentId, "agentId"); reply(socket, id, { agent: await provider.resumeAgent(agentId) }); return; }
      if (message.method === "workspace.select") { reply(socket, id, { root: workspace.select(requiredString(params.path, "path")) }); return; }
      if (message.method === "workspace.info") { reply(socket, id, { root: safeWorkspaceRoot(workspace) }); return; }
      if (message.method === "tools.list") { reply(socket, id, tools.list()); return; }
      if (message.method === "tool.call") { const call = params.call as ToolCall | undefined; if (!call || typeof call.tool !== "string") throw new Error("call.tool is required"); reply(socket, id, await executeTool(call, socket)); return; }
      reply(socket, id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
    } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); } }); socket.on("close", () => { clients.delete(socket); roles.delete(socket); }); });
  return { httpServer, wsServer, async close() { if (shuttingDown) return; shuttingDown = true; githubInitialization.clear(); await stopGitHubMcp(); try { await browserProvider?.stop(); } catch (error) { console.error("[BrowserCodingAgent] Browser shutdown failed:", error); } for (const client of clients) wsSocket(client).terminate(); await new Promise<void>((resolveClose) => { const timer = setTimeout(resolveClose, SHUTDOWN_TIMEOUT_MS); wsServerLike(wsServer).close(() => { clearTimeout(timer); resolveClose(); }); }); await new Promise<void>((resolveClose) => httpServer.close(() => resolveClose())); } };
}
export async function startRuntimeServer(port = DEFAULT_PORT): Promise<ReturnType<typeof createRuntimeServer>> { const runtime = createRuntimeServer(port); await new Promise<void>((resolveListen) => runtime.httpServer.listen(port, "127.0.0.1", resolveListen)); console.log(`Browser Coding Agent runtime listening on http://127.0.0.1:${port}`); return runtime; }
const invokedScript = process.argv[1] ? resolve(process.argv[1]) : "";
const currentScript = resolve(fileURLToPath(import.meta.url));
if (invokedScript === currentScript) { const runtime = await startRuntimeServer(); let closing = false; const shutdown = async (signal: string) => { if (closing) return; closing = true; console.log(`Received ${signal}, shutting down...`); await runtime.close(); process.exit(0); }; process.on("SIGINT", () => void shutdown("SIGINT")); process.on("SIGTERM", () => void shutdown("SIGTERM")); }
