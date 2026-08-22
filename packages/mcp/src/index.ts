import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ToolDescriptor, ToolResult } from "@browser-coding-agent/protocol";

export interface McpTool { readonly name: string; readonly description?: string; readonly inputSchema?: unknown; }
export interface McpServerInfo { readonly name: string; readonly version?: string; }
export interface McpCallResult { readonly content?: readonly unknown[]; readonly structuredContent?: unknown; readonly isError?: boolean; }

type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: any; error?: { code: number; message: string; data?: unknown } };

export function mcpToolToDescriptor(tool: McpTool): ToolDescriptor {
  return { name: tool.name, description: tool.description ?? `MCP tool ${tool.name}`, risk: "read" };
}

export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private initialized = false;

  constructor(private readonly command: string, private readonly args: readonly string[] = [], private readonly env?: NodeJS.ProcessEnv) {}

  async start(): Promise<McpServerInfo> {
    if (this.child) throw new Error("MCP client already started");
    this.child = spawn(this.command, [...this.args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.env }, windowsHide: true });
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => this.handleLine(line));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`MCP server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.child = undefined;
    });
    this.child.stderr.on("data", (chunk) => process.stderr.write(`[MCP] ${chunk.toString()}`));
    const result = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "browser-coding-agent", version: "0.1.0" } });
    this.notify("notifications/initialized", {});
    this.initialized = true;
    return result.serverInfo ?? { name: "mcp-server" };
  }

  async listTools(): Promise<readonly McpTool[]> {
    this.ensureReady();
    const result = await this.request("tools/list", {});
    return result.tools ?? [];
  }

  async callTool(name: string, arguments_: unknown): Promise<McpCallResult> {
    this.ensureReady();
    return this.request("tools/call", { name, arguments: arguments_ });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    for (const pending of this.pending.values()) pending.reject(new Error("MCP client stopped"));
    this.pending.clear();
    child.kill();
  }

  private request(method: string, params: unknown): Promise<any> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("MCP server is not running"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcResponse;
    try { message = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
  }

  private ensureReady(): void { if (!this.child || !this.initialized) throw new Error("MCP client is not initialized"); }
}

export function createMcpToolAdapter(client: McpStdioClient, tool: McpTool): { descriptor: ToolDescriptor; execute: (args: unknown) => Promise<ToolResult<unknown>> } {
  return {
    descriptor: mcpToolToDescriptor(tool),
    async execute(args) {
      try {
        const result = await client.callTool(tool.name, args);
        if (result.isError) return { ok: false, error: JSON.stringify(result.content ?? result) };
        return { ok: true, result: result.structuredContent ?? result.content ?? result };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
  };
}
