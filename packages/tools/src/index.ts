import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { LocalWorkspace, type ReplaceEdit } from "@browser-coding-agent/workspace";
import type { ToolDescriptor, ToolResult } from "@browser-coding-agent/protocol";

export interface Tool<TArguments = unknown, TResult = unknown> {
  readonly descriptor: ToolDescriptor;
  execute(arguments_: TArguments): Promise<ToolResult<TResult>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.descriptor.name)) throw new Error(`Tool already registered: ${tool.descriptor.name}`);
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): Tool | undefined { return this.tools.get(name); }
  list(): readonly ToolDescriptor[] { return [...this.tools.values()].map(({ descriptor }) => descriptor); }
}

export class WorkspaceManager {
  private root: string | undefined;
  private backend: LocalWorkspace | undefined;
  private readonly snapshots = new Map<string, string>();

  select(root: string): string {
    this.root = path.resolve(root);
    this.backend = new LocalWorkspace(this.root);
    this.snapshots.clear();
    return this.root;
  }

  getRoot(): string { if (!this.root) throw new Error("No workspace selected"); return this.root; }

  resolve(relativePath = "."): string { return this.getBackend().resolve(relativePath); }

  async read(relativePath: string, range?: { startLine: number; endLine: number }): Promise<string> {
    const file = await this.getBackend().read(relativePath, range);
    this.snapshots.set(relativePath, file.sha256);
    return file.content;
  }

  async write(relativePath: string, content: string, expectedSha256?: string): Promise<{ path: string; sha256: string; changed: boolean }> {
    const expected = expectedSha256 ?? this.snapshots.get(relativePath);
    const result = await this.getBackend().write(relativePath, content, expected ? { expectedSha256: expected } : undefined);
    this.snapshots.set(relativePath, result.sha256);
    return { path: result.path, sha256: result.sha256, changed: result.changed };
  }

  async applyEdits(relativePath: string, edits: readonly ReplaceEdit[], expectedSha256?: string): Promise<{ path: string; sha256: string; changed: boolean }> {
    const expected = expectedSha256 ?? this.snapshots.get(relativePath);
    const result = await this.getBackend().applyEdits(relativePath, edits, expected ? { expectedSha256: expected } : undefined);
    this.snapshots.set(relativePath, result.sha256);
    return { path: result.path, sha256: result.sha256, changed: result.changed };
  }

  private getBackend(): LocalWorkspace {
    if (!this.backend) throw new Error("No workspace selected");
    return this.backend;
  }
}

export interface FsListArguments { readonly path?: string; }
export interface FsReadArguments { readonly path: string; readonly encoding?: BufferEncoding; readonly startLine?: number; readonly endLine?: number; }
export interface FsWriteArguments { readonly path: string; readonly content: string; readonly expectedSha256?: string; }
export interface FsPatchArguments { readonly path: string; readonly edits: readonly ReplaceEdit[]; readonly expectedSha256?: string; }
export interface FsSearchArguments { readonly query: string; readonly path?: string; }
export interface TerminalExecArguments { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; }

function toolError(error: unknown): ToolResult<never> { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }

export function createFilesystemTools(workspace: WorkspaceManager): Tool[] {
  const list: Tool<FsListArguments, string[]> = {
    descriptor: { name: "fs.list", description: "List entries in the selected workspace.", risk: "read" },
    async execute(args) { try { const entries = await fs.readdir(workspace.resolve(args.path ?? "."), { withFileTypes: true }); return { ok: true, result: entries.map((entry) => `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`) }; } catch (error) { return toolError(error); } },
  };
  const read: Tool<FsReadArguments, string> = {
    descriptor: { name: "fs.read", description: "Read a UTF-8 file in the selected workspace, optionally by line range.", risk: "read" },
    async execute(args) {
      try {
        const range = args.startLine !== undefined || args.endLine !== undefined ? { startLine: args.startLine ?? 1, endLine: args.endLine ?? args.startLine ?? 1 } : undefined;
        return { ok: true, result: await workspace.read(args.path, range) };
      } catch (error) { return toolError(error); }
    },
  };
  const write: Tool<FsWriteArguments, { path: string; sha256: string; changed: boolean }> = {
    descriptor: { name: "fs.write", description: "Safely write a workspace file with an optimistic SHA precondition when the file was previously read.", risk: "write" },
    async execute(args) { try { return { ok: true, result: await workspace.write(args.path, args.content, args.expectedSha256) }; } catch (error) { return toolError(error); } },
  };
  const patch: Tool<FsPatchArguments, { path: string; sha256: string; changed: boolean }> = {
    descriptor: { name: "fs.patch", description: "Apply exact, non-overlapping text edits with SHA preconditions and atomic writes.", risk: "write" },
    async execute(args) { try { return { ok: true, result: await workspace.applyEdits(args.path, args.edits, args.expectedSha256) }; } catch (error) { return toolError(error); } },
  };
  const search: Tool<FsSearchArguments, string[]> = {
    descriptor: { name: "fs.search", description: "Search text recursively in common source files.", risk: "read" },
    async execute(args) {
      try {
        const results = await workspace.getRoot();
        const matches = await new LocalWorkspace(results).search(args.query, args.path ?? ".");
        return { ok: true, result: matches.map((match) => `${match.path}:${match.line}\t${match.preview}`) };
      } catch (error) { return toolError(error); }
    },
  };
  return [list, read, write, patch, search];
}

export function createTerminalTools(workspace: WorkspaceManager): Tool[] {
  const execTool: Tool<TerminalExecArguments, { code: number | null; stdout: string; stderr: string }> = {
    descriptor: { name: "terminal.exec", description: "Execute a shell command inside the selected workspace.", risk: "execute" },
    execute(args) {
      return new Promise((resolve) => {
        let cwd: string;
        try { cwd = workspace.resolve(args.cwd ?? "."); } catch (error) { resolve(toolError(error)); return; }
        if (!args.command.trim()) { resolve({ ok: false, error: "command must be a non-empty string" }); return; }
        const child = process.platform === "win32"
          ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", args.command], { cwd, windowsHide: true })
          : spawn("/bin/sh", ["-lc", args.command], { cwd });
        let stdout = ""; let stderr = ""; let settled = false;
        const finish = (result: ToolResult<{ code: number | null; stdout: string; stderr: string }>) => { if (!settled) { settled = true; resolve(result); } };
        child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const timeout = args.timeoutMs && args.timeoutMs > 0 ? setTimeout(() => { child.kill(); finish({ ok: false, error: `Command timed out after ${args.timeoutMs}ms` }); }, args.timeoutMs) : undefined;
        child.on("error", (error) => { if (timeout) clearTimeout(timeout); finish(toolError(error)); });
        child.on("close", (code) => { if (timeout) clearTimeout(timeout); finish({ ok: code === 0, result: { code, stdout, stderr }, ...(code === 0 ? {} : { error: `Command exited with code ${code}` }) }); });
      });
    },
  };
  return [execTool];
}