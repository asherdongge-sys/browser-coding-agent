import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { RpcMessage, ToolCall } from "@browser-coding-agent/protocol";
import { PermissionManager } from "@browser-coding-agent/permissions";
import { ToolRegistry, WorkspaceManager, createFilesystemTools, createTerminalTools } from "@browser-coding-agent/tools";

export const DEFAULT_PORT = 4317;

export function createRuntimeServer(port = Number(process.env.BROWSER_CODING_AGENT_PORT ?? DEFAULT_PORT)) {
  const workspace = new WorkspaceManager();
  const tools = new ToolRegistry();
  const permissions = new PermissionManager({ defaultDecision: "deny", rules: { read: "allow", write: "ask", execute: "ask", git: "ask" } });
  for (const tool of [...createFilesystemTools(workspace), ...createTerminalTools(workspace)]) tools.register(tool);

  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "browser-coding-agent", protocol: "0.1", workspace: safeWorkspaceRoot(workspace) }));
  });
  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.on("message", async (raw: Buffer) => {
      let message: RpcMessage;
      try { message = JSON.parse(raw.toString()) as RpcMessage; }
      catch { socket.send(JSON.stringify({ jsonrpc: "2.0", id: "invalid", error: { code: -32700, message: "Invalid JSON" } })); return; }
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
          const decision = permissions.decide({ tool: tool.descriptor.name, risk: tool.descriptor.risk, description: tool.descriptor.description });
          if (decision !== "allow") { reply(socket, id, { ok: false, error: `Permission ${decision} for ${tool.descriptor.name}` }); return; }
          reply(socket, id, await tool.execute(call.arguments)); return;
        }
        reply(socket, id, undefined, { code: -32601, message: `Method not found: ${message.method}` });
      } catch (error) { reply(socket, id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) }); }
    });
  });
  return { httpServer, wsServer, port };
}

function asRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object") throw new Error("params must be an object"); return value as Record<string, unknown>; }
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`); return value; }
function safeWorkspaceRoot(workspace: WorkspaceManager): string | null { try { return workspace.getRoot(); } catch { return null; } }
function reply(socket: import("ws").WebSocket, id: string | number, result?: unknown, error?: { code: number; message: string }): void { socket.send(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })); }

const runtime = createRuntimeServer();
runtime.httpServer.listen(runtime.port, "127.0.0.1", () => console.log(`Browser Coding Agent runtime listening on 127.0.0.1:${runtime.port}`));
