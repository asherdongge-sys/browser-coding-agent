import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ApprovalResponse, RpcMessage, ToolCall } from "@browser-coding-agent/protocol";
import { PermissionManager } from "@browser-coding-agent/permissions";
import { ToolRegistry, WorkspaceManager, createFilesystemTools, createTerminalTools } from "@browser-coding-agent/tools";

export const DEFAULT_PORT = 4317;

type PendingApproval = { socket: WebSocket; id: string | number; call: ToolCall; toolName: string };

export function createRuntimeServer(port = Number(process.env.BROWSER_CODING_AGENT_PORT ?? DEFAULT_PORT)) {
  const workspace = new WorkspaceManager();
  const tools = new ToolRegistry();
  const permissions = new PermissionManager({ defaultDecision: "deny", rules: { read: "allow", write: "ask", execute: "ask", git: "ask" } });
  const pending = new Map<string, PendingApproval>();
  const clients = new Set<WebSocket>();
  const sessionAllowed = new Set<string>();
  for (const tool of [...createFilesystemTools(workspace), ...createTerminalTools(workspace)]) tools.register(tool);

  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "browser-coding-agent", protocol: "0.1", workspace: safeWorkspaceRoot(workspace), clients: clients.size }));
  });
  const wsServer = new WebSocketServer({ server: httpServer });

  const broadcast = (message: unknown): void => {
    const payload = JSON.stringify(message);
    for (const client of clients) safeSend(client, payload);
  };

  wsServer.on("connection", (socket) => {
    clients.add(socket);
    socket.on("message", async (raw: Buffer) => {
      let message: RpcMessage;
      try { message = JSON.parse(raw.toString()) as RpcMessage; } catch { safeSend(socket, { jsonrpc: "2.0", id: "invalid", error: { code: -32700, message: "Invalid JSON" } }); return; }

      if ("method" in message && message.method === "approval.respond" && "id" in message) {
        let response: ApprovalResponse;
        try { response = asApprovalResponse(message.params); } catch (error) { reply(socket, message.id, undefined, { code: -32602, message: error instanceof Error ? error.message : String(error) }); return; }
        const request = pending.get(response.requestId);
        if (!request) { reply(socket, message.id, undefined, { code: -32004, message: "Approval request not found or already resolved" }); return; }
        pending.delete(response.requestId);
        if (response.decision === "deny") { reply(request.socket, request.id, { ok: false, error: "Permission denied by user" }); reply(socket, message.id, { ok: true }); return; }
        if (response.decision === "allow_session") sessionAllowed.add(request.toolName);
        const tool = tools.get(request.toolName);
        if (!tool) { reply(request.socket, request.id, { ok: false, error: "Tool no longer available" }); reply(socket, message.id, { ok: true }); return; }
        try { reply(request.socket, request.id, await tool.execute(request.call.arguments)); } catch (error) { reply(request.socket, request.id, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
        reply(socket, message.id, { ok: true }); return;
      }

      if (!("method" in message) || !("id" in message)) return;
      const id = message.id;
      try {
        if (message.method === "runtime.ping") { reply(socket, id, { ok: true, protocol: "0.1" }); return; }
        if (message.method === "workspace.select") { const params = asRecord(message.params); reply(socket, id, { root: workspace.select(requiredString(params.path, "path")) }); return; }
        if (message.method === "workspace.info") { reply(socket, id, { root: safeWorkspaceRoot(workspace) }); return; }
        if (message.method === "tools.list") { reply(socket, id, tools.list()); return; }
        if (message.method === "tool.call") {
          const params = asRecord(message.params); const call = params.call as ToolCall | undefined;
          if (!call || typeof call.tool !== "string") throw new Error("call.tool is required");
          const tool = tools.get(call.tool); if (!tool) throw new Error(`Unknown tool: ${call.tool}`);
          const decision = sessionAllowed.has(tool.descriptor.name) ? "allow" : permissions.decide({ tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description });
          if (decision === "ask") {
            const requestId = crypto.randomUUID();
            pending.set(requestId, { socket, id, call, toolName: tool.descriptor.name });
            broadcast({ jsonrpc: "2.0", method: "approval.request", params: { requestId, tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description, arguments: call.arguments } });
            return;
          }
          if (decision !== "allow") { reply(socket, id, { ok: false, error: `Permission ${decision} for ${tool.descriptor.name}` }); return; }
          reply(socket, id, await tool.execute(call.arguments)); return;
        }
        reply(socket, id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
      } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
    });
    socket.on("close", () => {
      clients.delete(socket);
      for (const [requestId, request] of pending) if (request.socket === socket) pending.delete(requestId);
    });
  });
  return { httpServer, wsServer, port };
}

function safeSend(socket: WebSocket, message: unknown): void {
  if (socket.readyState === 1) socket.send(typeof message === "string" ? message : JSON.stringify(message));
}
function asRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object") throw new Error("params must be an object"); return value as Record<string, unknown>; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value; }
function asApprovalResponse(value: unknown): ApprovalResponse { const record = asRecord(value); const requestId = requiredString(record.requestId, "requestId"); const decision = record.decision; if (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny") throw new Error("Invalid approval decision"); return { requestId, decision }; }
function safeWorkspaceRoot(workspace: WorkspaceManager): string | null { try { return workspace.getRoot(); } catch { return null; } }
function reply(socket: WebSocket, id: string | number, result?: unknown, error?: { code: number; message: string }): void { safeSend(socket, { jsonrpc: "2.0", id, ...(error ? { error } : { result }) }); }

const runtime = createRuntimeServer();
runtime.httpServer.listen(runtime.port, "127.0.0.1", () => console.log(`Browser Coding Agent runtime listening on 127.0.0.1:${runtime.port}`));
