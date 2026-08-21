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

export const DEFAULT_PORT = 4317;
type PendingApproval = { socket: WebSocket | undefined; id: string | number | undefined; call: ToolCall; toolName: string; resolve: (result: ToolResult<unknown>) => void };
const DASHBOARD_FILE = fileURLToPath(new URL("../web/index.html", import.meta.url));
const SHUTDOWN_TIMEOUT_MS = 3000;

export function createRuntimeServer(port = Number(process.env.BROWSER_CODING_AGENT_PORT ?? DEFAULT_PORT)) {
  const workspace = new WorkspaceManager();
  const tools = new ToolRegistry();
  const permissions = new PermissionManager({ defaultDecision: "deny", rules: { read: "allow", write: "ask", execute: "ask", git: "ask" } });
  const pending = new Map<string, PendingApproval>();
  const clients = new Set<WebSocket>();
  const roles = new Map<WebSocket, "extension" | "dashboard" | "unknown">();
  const forwarded = new Map<string, WebSocket>();
  const sessionAllowed = new Set<string>();
  const providerKind = process.env.BROWSER_PROVIDER === "playwright" ? "playwright" : "extension";
  let browserProvider: BrowserProvider | undefined;
  let browserStartup: Promise<void> | undefined;
  let shuttingDown = false;
  for (const tool of [...createFilesystemTools(workspace), ...createTerminalTools(workspace)]) tools.register(tool);

  const broadcast = (message: unknown, role?: "extension" | "dashboard"): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) if (!role || roles.get(client) === role) safeSend(client, payload);
  };
  const emitAgentEvent = (event: AgentEvent): void => broadcast({ jsonrpc: "2.0", method: "agent.event", params: event });
  const emitBrowserEvent = (event: BrowserAgentEvent): void => broadcast({ jsonrpc: "2.0", method: "dashboard.event", params: event });

  if (providerKind === "playwright") {
    browserProvider = new PlaywrightBrowserProvider({ onEvent: emitBrowserEvent });
    browserStartup = browserProvider.start().catch((error) => console.error("[BrowserCodingAgent] Playwright startup failed:", error));
  }

  const executeTool = <TArguments = unknown, TResult = unknown>(call: ToolCall<TArguments>, requester?: WebSocket, requestId?: string | number): Promise<ToolResult<TResult>> => {
    const tool = tools.get(call.tool);
    if (!tool) return Promise.resolve({ ok: false, error: `Unknown tool: ${call.tool}` });
    const decision = sessionAllowed.has(tool.descriptor.name) ? "allow" : permissions.decide({ tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description });
    if (decision === "ask") return new Promise<ToolResult<TResult>>((resolve) => {
      const approvalId = crypto.randomUUID();
      pending.set(approvalId, { socket: requester, id: requestId, call, toolName: tool.descriptor.name, resolve: (result) => resolve(result as ToolResult<TResult>) });
      broadcast({ jsonrpc: "2.0", method: "approval.request", params: { requestId: approvalId, tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description, arguments: call.arguments } });
    });
    if (decision !== "allow") return Promise.resolve({ ok: false, error: `Permission ${decision} for ${tool.descriptor.name}` });
    return tool.execute(call.arguments).then((result) => result as ToolResult<TResult>);
  };

  const deterministicPlanner = async (context: AgentContext): Promise<readonly ToolCall[]> => {
    const normalized = context.goal.toLowerCase();
    const last = context.history.at(-1);
    if (last?.result?.ok === false) {
      const error = last.result.error ?? "";
      if (last.call.tool === "terminal.exec" && error.includes("ERR_UNKNOWN_FILE_EXTENSION")) return [{ tool: "fs.write", arguments: { path: "hello.js", content: 'console.log("Hello from Browser Coding Agent");\n' } }, { tool: "terminal.exec", arguments: { command: "node hello.js" } }];
      return [];
    }
    if (normalized.includes("hello") && (normalized.includes("创建") || normalized.includes("create"))) {
      if (context.history.some((step) => step.call.tool === "terminal.exec" && step.result?.ok)) return [];
      return [{ tool: "fs.write", arguments: { path: "hello.ts", content: 'console.log("Hello from Browser Coding Agent");\n' } }, { tool: "terminal.exec", arguments: { command: "node hello.ts" } }];
    }
    if (!context.history.length) return [{ tool: "fs.list", arguments: { path: "." } }, { tool: "fs.read", arguments: { path: "package.json" } }];
    return [];
  };

  const httpServer = createServer(async (request, response) => {
    if (shuttingDown) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: false, error: "Runtime is shutting down" })); return; }
    if (request.url === "/" || request.url === "/index.html") {
      try { const html = await readFile(DASHBOARD_FILE, "utf8"); response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); response.end(html); }
      catch (error) { response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }); response.end(error instanceof Error ? error.message : String(error)); }
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "browser-coding-agent", protocol: "0.1", workspace: safeWorkspaceRoot(workspace), clients: clients.size, dashboards: [...roles.values()].filter((role) => role === "dashboard").length, extensions: [...roles.values()].filter((role) => role === "extension").length, browserProvider: providerKind, planner: "chatgpt-browser" }));
  });
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    clients.add(socket); roles.set(socket, "unknown");
    socket.on("message", async (raw: Buffer) => {
      let message: RpcMessage;
      try { message = JSON.parse(raw.toString()) as RpcMessage; }
      catch { safeSend(socket, { jsonrpc: "2.0", id: "invalid", error: { code: -32700, message: "Invalid JSON" } }); return; }

      if ("id" in message && !("method" in message) && forwarded.has(String(message.id))) {
        const requester = forwarded.get(String(message.id)); forwarded.delete(String(message.id)); if (requester) safeSend(requester, JSON.stringify(message)); return;
      }
      if ("method" in message && message.method === "runtime.hello" && "id" in message) {
        const role = asRecord(message.params).role; roles.set(socket, role === "extension" ? "extension" : "dashboard"); reply(socket, message.id, { ok: true, role: roles.get(socket), browserProvider: providerKind }); return;
      }
      if ("method" in message && message.method === "dashboard.event") { broadcast(message, "dashboard"); return; }

      if ("method" in message && (message.method === "agent.list" || message.method === "agent.create" || message.method === "agent.send" || message.method === "agent.resume")) {
        const id = "id" in message ? message.id : undefined;
        if (id === undefined) return;
        if (browserProvider) {
          try {
            const params = asRecord(message.params);
            if (message.method === "agent.list") { reply(socket, id, { agents: await browserProvider.listAgents() }); return; }
            if (message.method === "agent.create") { reply(socket, id, { agent: await browserProvider.createAgent(typeof params.title === "string" ? params.title : "", typeof params.prompt === "string" ? params.prompt : "") }); return; }
            if (message.method === "agent.send") { await browserProvider.sendMessage(requiredString(params.agentId, "agentId"), requiredString(params.text, "text")); reply(socket, id, { ok: true }); return; }
            if (message.method === "agent.resume") { reply(socket, id, { ok: true, agent: await browserProvider.resumeAgent(requiredString(params.agentId, "agentId")) }); return; }
          } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); return; }
        }
        const extension = [...clients].find((client) => roles.get(client) === "extension");
        if (!extension) { reply(socket, id, undefined, { code: -32010, message: "Browser extension is not connected" }); return; }
        forwarded.set(String(id), socket);
        const params = asRecord(message.params);
        safeSend(extension, { jsonrpc: "2.0", id, method: "dashboard.request", params: { ...params, method: message.method.slice("agent.".length) } });
        return;
      }

      if ("method" in message && message.method === "approval.respond" && "id" in message) {
        let approval: ApprovalResponse;
        try { approval = asApprovalResponse(message.params); }
        catch (error) { reply(socket, message.id, undefined, { code: -32602, message: error instanceof Error ? error.message : String(error) }); return; }
        const request = pending.get(approval.requestId);
        if (!request) { reply(socket, message.id, undefined, { code: -32004, message: "Approval request not found or already resolved" }); return; }
        pending.delete(approval.requestId);
        if (approval.decision === "deny") request.resolve({ ok: false, error: "Permission denied by user" });
        else {
          if (approval.decision === "allow_session") sessionAllowed.add(request.toolName);
          const tool = tools.get(request.toolName);
          if (!tool) request.resolve({ ok: false, error: "Tool no longer available" });
          else { try { request.resolve(await tool.execute(request.call.arguments)); } catch (error) { request.resolve({ ok: false, error: error instanceof Error ? error.message : String(error) }); } }
        }
        reply(socket, message.id, { ok: true }); return;
      }
      if (!("method" in message) || !("id" in message)) return;
      const id = message.id;
      try {
        if (message.method === "runtime.ping") { reply(socket, id, { ok: true, protocol: "0.1", planner: "chatgpt-browser", browserProvider: providerKind }); return; }
        if (message.method === "workspace.select") { const params = asRecord(message.params); reply(socket, id, { root: workspace.select(requiredString(params.path, "path")) }); return; }
        if (message.method === "workspace.info") { reply(socket, id, { root: safeWorkspaceRoot(workspace) }); return; }
        if (message.method === "tools.list") { reply(socket, id, tools.list()); return; }
        if (message.method === "tool.call") { const params = asRecord(message.params); const call = params.call as ToolCall | undefined; if (!call || typeof call.tool !== "string") throw new Error("call.tool is required"); if (safeWorkspaceRoot(workspace) === null) throw new Error("No workspace selected"); reply(socket, id, await executeTool(call, socket, id)); return; }
        if (message.method === "agent.run") {
          const params = asRecord(message.params); const goal = requiredString(params.goal, "goal");
          if (safeWorkspaceRoot(workspace) === null) { reply(socket, id, undefined, { code: -32001, message: "No workspace selected" }); return; }
          void (async () => { try { const loop = new AgentLoop({ callTool: (call) => executeTool(call) }, deterministicPlanner); await loop.run({ goal, history: [] }, emitAgentEvent); reply(socket, id, { ok: loop.getState() === "completed", state: loop.getState(), planner: "deterministic" }); } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); } })(); return;
        }
        reply(socket, id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
      } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
    });
    socket.on("close", () => { clients.delete(socket); roles.delete(socket); for (const [id, requester] of forwarded) if (requester === socket) forwarded.delete(id); });
  });

  const closeHttpServer = (): Promise<void> => new Promise((resolve, reject) => { if (!httpServer.listening) { resolve(); return; } httpServer.close((error) => error ? reject(error) : resolve()); });
  const closeWebSocketServer = (): Promise<void> => new Promise((resolve) => { try { for (const socket of wsServer.clients) socket.terminate(); wsServer.close(() => resolve()); } catch { resolve(); } });
  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) { console.warn(`[BrowserCodingAgent] Shutdown already in progress; ignoring ${signal}`); return; }
    shuttingDown = true;
    console.log(`[BrowserCodingAgent] Received ${signal}, shutting down...`);
    const forceExit = setTimeout(() => { console.error(`[BrowserCodingAgent] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; forcing exit`); process.exit(1); }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    try {
      for (const socket of clients) { try { socket.terminate(); } catch {} }
      clients.clear(); roles.clear(); forwarded.clear();
      try { await withTimeout(closeWebSocketServer(), 1000, "WebSocket server shutdown"); } catch (error) { console.error("[BrowserCodingAgent] WebSocket shutdown failed:", error); }
      try { await withTimeout(closeHttpServer(), 1000, "HTTP server shutdown"); } catch (error) { console.error("[BrowserCodingAgent] HTTP shutdown failed:", error); }
      if (browserProvider) { try { await withTimeout(browserProvider.stop(), 2000, "Browser provider shutdown"); } catch (error) { console.error("[BrowserCodingAgent] Browser provider shutdown failed:", error); } }
      if (browserStartup) { try { await withTimeout(browserStartup, 1000, "Browser startup cancellation"); } catch {} }
      for (const request of pending.values()) request.resolve({ ok: false, error: "Runtime shutting down" });
      pending.clear(); sessionAllowed.clear();
      console.log("[BrowserCodingAgent] Shutdown complete");
    } finally { clearTimeout(forceExit); process.exit(0); }
  };

  const installSignalHandlers = (): void => { process.once("SIGINT", () => { void shutdown("SIGINT"); }); process.once("SIGTERM", () => { void shutdown("SIGTERM"); }); };
  return { httpServer, wsServer, port, shutdown, installSignalHandlers };
}
function safeSend(socket: WebSocket, message: unknown): void { try { if (socket.readyState === WebSocket.OPEN) socket.send(typeof message === "string" ? message : JSON.stringify(message)); } catch {} }
function asRecord(value: unknown): Record<string, any> { if (!value || typeof value !== "object") throw new Error("params must be an object"); return value as Record<string, any>; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value; }
function asApprovalResponse(value: unknown): ApprovalResponse { const record = asRecord(value); const requestId = requiredString(record.requestId, "requestId"); const decision = record.decision; if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") throw new Error("Invalid approval decision"); return { requestId, decision }; }
function safeWorkspaceRoot(workspace: WorkspaceManager): string | null { try { return workspace.getRoot(); } catch { return null; } }
function reply(socket: WebSocket, id: string | number | undefined, result?: unknown, error?: { code: number; message: string }): void { safeSend(socket, { jsonrpc: "2.0", id, ...(error ? { error } : { result }) }); }

const runtime = createRuntimeServer();
runtime.installSignalHandlers();
runtime.httpServer.listen(runtime.port, "127.0.0.1", () => console.log(`Browser Coding Agent runtime listening on http://127.0.0.1:${runtime.port}`));
