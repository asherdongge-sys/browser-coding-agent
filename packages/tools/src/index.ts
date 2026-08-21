import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
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
  select(root: string): string { this.root = path.resolve(root); return this.root; }
  getRoot(): string { if (!this.root) throw new Error("No workspace selected"); return this.root; }
  resolve(relativePath = "."): string {
    const root = this.getRoot();
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path escapes the selected workspace");
    return resolved;
  }
}

export interface FsListArguments { readonly path?: string; }
export interface FsReadArguments { readonly path: string; readonly encoding?: BufferEncoding; }
export interface FsWriteArguments { readonly path: string; readonly content: string; }
export interface FsSearchArguments { readonly query: string; readonly path?: string; }
export interface TerminalExecArguments { readonly command: string; readonly cwd?: string; readonly timeoutMs?: number; }

function toolError(error: unknown): ToolResult<never> { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }

export function createFilesystemTools(workspace: WorkspaceManager): Tool[] {
  const list: Tool<FsListArguments, string[]> = {
    descriptor: { name: "fs.list", description: "List entries in the selected workspace.", risk: "read" },
    async execute(args) { try { const entries = await fs.readdir(workspace.resolve(args.path ?? "."), { withFileTypes: true }); return { ok: true, result: entries.map((entry) => `${entry.isDirectory() ? "dir" : "file"}\t${entry.name}`) }; } catch (error) { return toolError(error); } },
  };
  const read: Tool<FsReadArguments, string> = {
    descriptor: { name: "fs.read", description: "Read a UTF-8 file in the selected workspace.", risk: "read" },
    async execute(args) { try { const content = await fs.readFile(workspace.resolve(args.path), args.encoding ?? "utf8"); return { ok: true, result: content.toString() }; } catch (error) { return toolError(error); } },
  };
  const write: Tool<FsWriteArguments, { path: string }> = {
    descriptor: { name: "fs.write", description: "Write a file in the selected workspace.", risk: "write" },
    async execute(args) { try { const target = workspace.resolve(args.path); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, args.content, "utf8"); return { ok: true, result: { path: target } }; } catch (error) { return toolError(error); } },
  };
  const search: Tool<FsSearchArguments, string[]> = {
    descriptor: { name: "fs.search", description: "Search text recursively in common source files.", risk: "read" },
    async execute(args) {
      try {
        const root = workspace.resolve(args.path ?? "."); const results: string[] = []; const ignored = new Set([".git", "node_modules", "dist", "build"]);
        async function walk(directory: string): Promise<void> { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { if (ignored.has(entry.name)) continue; const target = path.join(directory, entry.name); if (entry.isDirectory()) await walk(target); else if (entry.isFile() && (await fs.stat(target)).size < 1024 * 1024) { const content = await fs.readFile(target, "utf8").catch(() => ""); if (content.includes(args.query)) results.push(path.relative(workspace.getRoot(), target)); } } }
        await walk(root); return { ok: true, result: results };
      } catch (error) { return toolError(error); }
    },
  };
  return [list, read, write, search];
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
