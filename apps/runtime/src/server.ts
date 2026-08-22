import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AgentLoop, type AgentEvent, type AgentContext } from "@browser-coding-agent/agent-core";
import type { ApprovalResponse, RpcMessage, ToolCall, ToolResult } from "@browser-coding-agent/protocol";
import { PermissionManager } from "@browser-coding-agent/permissions";
import { ToolRegistry, WorkspaceManager, createFilesystemTools, createTerminalTools } from "@browser-coding-agent/tools";
import type { BrowserAgentEvent, BrowserProvider } from "./browser-provider.js";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { completeGitHubOAuth, createGitHubAuthorizeUrl, disconnectGitHub, getGitHubConnection, githubOAuthCallbackUrl, githubOAuthStatus } from "./github-oauth.js";

export const DEFAULT_PORT = 4317;
type PendingApproval = { socket: WebSocket | undefined; id: string | number | undefined; call: ToolCall; toolName: string; resolve: (result: ToolResult<unknown>) => void };
const DASHBOARD_FILE = fileURLToPath(new URL("../web/index.html", import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 3000;
type WsSocketLike = { terminate(): void; readyState: number; send(data: string): void };
type WsServerLike = { clients: Set<WsSocketLike>; close(callback?: (error?: Error) => void): void };
const wsSocket = (socket: WebSocket): WsSocketLike => socket as unknown as WsSocketLike;
const wsServerLike = (server: WebSocketServer): WsServerLike => server as unknown as WsServerLike;

export function createRuntimeServer(port = Number(process.env.BROWSER_CODING_AGENT_PORT ?? DEFAULT_PORT)) {
  const workspace = new WorkspaceManager(); const tools = new ToolRegistry();
  const permissions = new PermissionManager({ defaultDecision: "deny", rules: { read: "allow", write: "ask", execute: "ask", git: "ask" } });
  const pending = new Map<string, PendingApproval>(); const clients = new Set<WebSocket>(); const roles = new Map<WebSocket, "extension" | "dashboard" | "unknown">();
  const forwarded = new Map<string, WebSocket>(); const sessionAllowed = new Set<string>();
  const configuredProvider = (process.env.BROWSER_PROVIDER ?? "playwright").trim().toLowerCase(); const providerKind = configuredProvider === "extension" ? "extension" : "playwright";
  let browserProvider: BrowserProvider | undefined; let browserStartup: Promise<void> | undefined; let browserStartupError: Error | undefined; let shuttingDown = false;
  for (const tool of [...createFilesystemTools(workspace), ...createTerminalTools(workspace)]) tools.register(tool);
  const broadcast = (message: unknown, role?: "extension" | "dashboard"): void => { const payload = JSON.stringify(message); for (const client of clients) if (!role || roles.get(client) === role) safeSend(client, payload); };
  const emitAgentEvent = (event: AgentEvent): void => broadcast({ jsonrpc: "2.0", method: "agent.event", params: event });
  const emitBrowserEvent = (event: BrowserAgentEvent): void => broadcast({ jsonrpc: "2.0", method: "dashboard.event", params: event });
  if (providerKind === "playwright") { browserProvider = new PlaywrightBrowserProvider({ onEvent: emitBrowserEvent }); browserStartup = browserProvider.start().catch((error) => { browserStartupError = error instanceof Error ? error : new Error(String(error)); console.error("[BrowserCodingAgent] Playwright startup failed:", browserStartupError.message); }); }
  const executeTool = <TArguments = unknown, TResult = unknown>(call: ToolCall<TArguments>, requester?: WebSocket, requestId?: string | number): Promise<ToolResult<TResult>> => {
    const tool = tools.get(call.tool); if (!tool) return Promise.resolve({ ok: false, error: `Unknown tool: ${call.tool}` });
    const decision = sessionAllowed.has(tool.descriptor.name) ? "allow" : permissions.decide({ tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description });
    if (decision === "ask") return new Promise<ToolResult<TResult>>((resolve) => { const approvalId = crypto.randomUUID(); pending.set(approvalId, { socket: requester, id: requestId, call, toolName: tool.descriptor.name, resolve: (result) => resolve(result as ToolResult<TResult>) }); broadcast({ jsonrpc: "2.0", method: "approval.request", params: { requestId: approvalId, tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description, arguments: call.arguments } }); });
    if (decision !== "allow") return Promise.resolve({ ok: false, error: `Permission ${decision} for ${tool.descriptor.name}` });
    return tool.execute(call.arguments).then((result) => result as ToolResult<TResult>);
  };
  const deterministicPlanner = async (context: AgentContext): Promise<readonly ToolCall[]> => {
    const normalized = context.goal.toLowerCase(); const last = context.history.at(-1);
    if (last?.result?.ok === false) { const error = last.result.error ?? ""; if (last.call.tool === "terminal.exec" && error.includes("ERR_UNKNOWN_FILE_EXTENSION")) return [{ tool: "fs.write", arguments: { path: "hello.js", content: 'console.log("Hello from Browser Coding Agent");\n' } }, { tool: "terminal.exec", arguments: { command: "node hello.js" } }]; return []; }
    if (normalized.includes("hello") && (normalized.includes("创建") || normalized.includes("create"))) { if (context.history.some((step) => step.call.tool === "terminal.exec" && step.result?.ok)) return []; return [{ tool: "fs.write", arguments: { path: "hello.ts", content: 'console.log("Hello from Browser Coding Agent");\n' } }, { tool: "terminal.exec", arguments: { command: "node hello.ts" } }]; }
    if (!context.history.length) return [{ tool: "fs.list", arguments: { path: "." } }, { tool: "fs.read", arguments: { path: "package.json" } }]; return [];
  };
  const sendJson = (response: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }); response.end(JSON.stringify(body)); };
  const httpServer = createServer(async (request, response) => {
    if (shuttingDown) { sendJson(response, 503, { ok: false, error: "Runtime is shutting down" }); return; }
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") { try { const html = await readFile(DASHBOARD_FILE, "utf8"); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); } catch (error) { response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); response.end(error instanceof Error ? error.message : String(error)); } return; }
    if (requestUrl.pathname === "/api/github/status") { sendJson(response, 200, await githubOAuthStatus(port, await getGitHubConnection())); return; }
    if (requestUrl.pathname === "/api/github/connect") { try { const callback = githubOAuthCallbackUrl(port); response.writeHead(302, { location: await createGitHubAuthorizeUrl(callback), "cache-control": "no-store" }); response.end(); } catch (error) { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); } return; }
    if (requestUrl.pathname === "/api/github/callback") {
      const error = requestUrl.searchParams.get("error"); if (error) { response.writeHead(302, { location: `/?github=error&message=${encodeURIComponent(error)}` }); response.end(); return; }
      try { const code = requestUrl.searchParams.get("code"); const returnedState = requestUrl.searchParams.get("state"); if (!code || !returnedState) throw new Error("GitHub OAuth callback is missing code or state"); const connection = await completeGitHubOAuth(code, returnedState, githubOAuthCallbackUrl(port)); response.writeHead(302, { location: `/?github=connected&login=${encodeURIComponent(connection.login ?? "")}` }); response.end(); }
      catch (oauthError) { response.writeHead(302, { location: `/?github=error&message=${encodeURIComponent(oauthError instanceof Error ? oauthError.message : String(oauthError))}` }); response.end(); } return;
    }
    if (requestUrl.pathname === "/api/github/disconnect" && request.method === "POST") { await disconnectGitHub(); sendJson(response, 200, { ok: true }); return; }
    sendJson(response, 200, { name: "browser-coding-agent", protocol: "0.1", workspace: safeWorkspaceRoot(workspace), clients: clients.size, dashboards: [...roles.values()].filter((role) => role === "dashboard").length, extensions: [...roles.values()].filter((role) => role === "extension").length, browserProvider: providerKind, planner: "chatgpt-browser" });
  });
  const wsServer = new WebSocketServer({ server: httpServer });
  wsServer.on("connection", (socket) => {
    clients.add(socket); roles.set(socket, "unknown");
    socket.on("message", async (raw: Buffer) => {
      let message: RpcMessage; try { message = JSON.parse(raw.toString()) as RpcMessage; } catch { safeSend(socket, { jsonrpc: "2.0", id: "invalid", error: { code: -32700, message: "Invalid JSON" } }); return; }
      if (!("method" in message) || !("id" in message)) return; const id = message.id;
      try {
        if (message.method === "runtime.ping") { reply(socket, id, { ok: true, protocol: "0.1", planner: "chatgpt-browser", browserProvider: providerKind }); return; }
        if (message.method === "workspace.select") { const params = asRecord(message.params); reply(socket, id, { root: workspace.select(requiredString(params.path, "path")) }); return; }
        if (message.method === "workspace.info") { reply(socket, id, { root: safeWorkspaceRoot(workspace) }); return; }
        if (message.method === "tools.list") { reply(socket, id, tools.list()); return; }
        if (message.method === "tool.call") { const params = asRecord(message.params); const call = params.call as ToolCall | undefined; if (!call || typeof call.tool !== "string") throw new Error("call.tool is required"); if (safeWorkspaceRoot(workspace) === null) throw new Error("No workspace selected"); reply(socket, id, await executeTool(call, socket, id)); return; }
        if (message.method === "agent.run") { const params = asRecord(message.params); const goal = requiredString(params.goal, "goal"); if (safeWorkspaceRoot(workspace) === null) { reply(socket, id, undefined, { code: -32001, message: "No workspace selected" }); return; } void (async () => { try { const loop = new AgentLoop({ callTool: (call) => executeTool(call) }, deterministicPlanner); await loop.run({ goal, history: [] }, emitAgentEvent); reply(socket, id, { ok: loop.getState() === "completed", state: loop.getState(), planner: "deterministic" }); } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); } })(); return; }
        reply(socket, id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
      } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
    });
    socket.on("close", () => { clients.delete(socket); roles.delete(socket); });
  });
  return { httpServer, wsServer, async close() { if (shuttingDown) return; shuttingDown = true; try { await browserProvider?.stop(); } catch (error) { console.error("[BrowserCodingAgent] Browser shutdown failed:", error); } for (const client of clients) wsSocket(client).terminate(); await new Promise<void>((resolve) => { const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); wsServerLike(wsServer).close(() => { clearTimeout(timer); resolve(); }); }); await new Promise<void>((resolve) => httpServer.close(() => resolve())); } };
}
function safeSend(socket: WebSocket, message: unknown): void { if (socket.readyState === WebSocket.OPEN) socket.send(typeof message === "string" ? message : JSON.stringify(message)); }
function reply(socket: WebSocket, id: string | number, result?: unknown, error?: { code: number; message: string }): void { safeSend(socket, error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }); }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
function safeWorkspaceRoot(workspace: WorkspaceManager): string | null { try { return workspace.getRoot(); } catch { return null; } }
function asApprovalResponse(value: unknown): ApprovalResponse { const record = asRecord(value); if (typeof record.requestId !== "string") throw new Error("requestId is required"); const decision = record.decision; if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") throw new Error("Invalid approval decision"); return { requestId: record.requestId, decision }; }

export async function startRuntimeServer(port = DEFAULT_PORT): Promise<ReturnType<typeof createRuntimeServer>> { const runtime = createRuntimeServer(port); await new Promise<void>((resolve) => runtime.httpServer.listen(port, "127.0.0.1", resolve)); console.log(`Browser Coding Agent runtime listening on http://127.0.0.1:${port}`); return runtime; }

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const runtime = await startRuntimeServer();
  let closing = false;
  const shutdown = async (signal: string) => { if (closing) return; closing = true; console.log(`[BrowserCodingAgent] Received ${signal}, shutting down...`); await runtime.close(); console.log("[BrowserCodingAgent] Shutdown complete"); process.exit(0); };
  process.once("SIGINT", () => void shutdown("SIGINT")); process.once("SIGTERM", () => void shutdown("SIGTERM"));
}