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
    if (requestUrl.pathname === "/api/github/status") { sendJson(response, 200, githubOAuthStatus(port, await getGitHubConnection())); return; }
    if (requestUrl.pathname === "/api/github/connect") { try { const callback = githubOAuthCallbackUrl(port); response.writeHead(302, { location: createGitHubAuthorizeUrl(callback), "cache-control": "no-store" }); response.end(); } catch (error) { sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }); } return; }
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
      if ("id" in message && !("method" in message) && forwarded.has(String(message.id))) { const requester = forwarded.get(String(message.id)); forwarded.delete(String(message.id)); if (requester) safeSend(requester, JSON.stringify(message)); return; }
      if ("method" in message && message.method === "runtime.hello" && "id" in message) { const role = asRecord(message.params).role; roles.set(socket, role === "extension" ? "extension" : "dashboard"); reply(socket, message.id, { ok: true, role: roles.get(socket), browserProvider: providerKind }); return; }
      if ("method" in message && message.method === "dashboard.event") { broadcast(message, "dashboard"); return; }
      if ("method" in message && (message.method === "agent.list" || message.method === "agent.create" || message.method === "agent.send" || message.method === "agent.resume")) {
        const id = "id" in message ? message.id : undefined; if (id === undefined) return;
        if (providerKind === "playwright") { if (!browserProvider) { reply(socket, id, undefined, { code: -32011, message: "Playwright browser provider is not initialized" }); return; } if (browserStartupError) { reply(socket, id, undefined, { code: -32011, message: `Playwright browser provider failed to start: ${browserStartupError.message}` }); return; } try { await browserStartup; const params = asRecord(message.params); if (message.method === "agent.list") { reply(socket, id, { agents: await browserProvider.listAgents() }); return; } if (message.method === "agent.create") { reply(socket, id, { agent: await browserProvider.createAgent(typeof params.title === "string" ? params.title : "", typeof params.prompt === "string" ? params.prompt : "") }); return; } if (message.method === "agent.send") { await browserProvider.sendMessage(requiredString(params.agentId, "agentId"), requiredString(params.text, "text")); reply(socket, id, { ok: true }); return; } if (message.method === "agent.resume") { reply(socket, id, { ok: true, agent: await browserProvider.resumeAgent(requiredString(params.agentId, "agentId")) }); return; } } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); return; } }
        const extension = [...clients].find((client) => roles.get(client) === "extension"); if (!extension) { reply(socket, id, undefined, { code: -32010, message: "Browser extension is not connected" }); return; } forwarded.set(String(id), socket); const params = asRecord(message.params); safeSend(extension, { jsonrpc: "2.0", id, method: "dashboard.request", params: { ...params, method: message.method.slice("agent.".length) } }); return;
      }
      if ("method" in message && message.method === "approval.respond" && "id" in message) { let approval: ApprovalResponse; try { approval = asApprovalResponse(message.params); } catch (error) { reply(socket, message.id, undefined, { code: -32602, message: error instanceof Error ? error.message : String(error) }); return; } const request = pending.get(approval.requestId); if (!request) { reply(socket, message.id, undefined, { code: -32004, message: "Approval request not found or already resolved" }); return; } pending.delete(approval.requestId); if (approval.decision === "deny") request.resolve({ ok: false, error: "Permission denied by user" }); else { if (approval.decision === "allow_session") sessionAllowed.add(request.toolName); const tool = tools.get(request.toolName); if (!tool) request.resolve({ ok: false, error: "Tool no longer available" }); else { try { request.resolve(await tool.execute(request.call.arguments)); } catch (error) { request.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) }); } } } reply(socket, message.id, { ok: true }); return; }
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
    socket.on("close", () => { clients.delete(socket); roles.delete(socket); for (const [id, requester] of forwarded) if (requester === socket) forwarded.delete(id); for (const [id, approval] of pending) if (approval.socket === socket) { approval.resolve({ ok: false, error: "Client disconnected" }); pending.delete(id); } });
  });
  return { httpServer, wsServer, async close() { if (shuttingDown) return; shuttingDown = true; try { await browserProvider?.stop(); } catch (error) { console.error("[BrowserCodingAgent] Browser shutdown failed:", error); } for (const client of clients) wsSocket(client).terminate(); await new Promise<void>((resolve) => { const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS); wsServerLike(wsServer).close(() => { clearTimeout(timer); resolve(); }); }); await new Promise<void>((resolve) => httpServer.close(() => resolve())); } };
}
function safeSend(socket: WebSocket, message: unknown): void { if (socket.readyState === WebSocket.OPEN) socket.send(typeof message === "string" ? message : JSON.stringify(message)); }
function reply(socket: WebSocket, id: string | number, result?: unknown, error?: { code: number; message: string }): void { safeSend(socket, error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result }); }
function asRecord(value: unknown): Record<string, any> { return value && typeof value === "object" ? value as Record<string, any> : {}; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`); return value; }
function asApprovalResponse(value: unknown): ApprovalResponse { const record = asRecord(value); if (typeof record.requestId !== "string" || !["allow_once", "allow_session", "deny"].includes(record.decision)) throw new Error("Invalid approval response"); return record as ApprovalResponse; }
function safeWorkspaceRoot(workspace: WorkspaceManager): string | null { try { return workspace.getRoot(); } catch { return null; } }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runtime = createRuntimeServer(); runtime.httpServer.listen(DEFAULT_PORT, "127.0.0.1", () => console.log(`Browser Coding Agent runtime listening on http://127.0.0.1:${DEFAULT_PORT}`));
  let stopping = false; const shutdown = async () => { if (stopping) return; stopping = true; console.log("[BrowserCodingAgent] shutting down..."); await runtime.close(); console.log("[BrowserCodingAgent] Shutdown complete"); process.exitCode = 0; };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
}
