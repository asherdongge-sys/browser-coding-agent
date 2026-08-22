import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface TextRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly range?: TextRange;
}

export interface WorkspaceSearchResult {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
}

export interface ReplaceEdit {
  readonly start: number;
  readonly end: number;
  readonly oldText: string;
  readonly newText: string;
}

export interface ApplyEditsOptions {
  readonly expectedSha256?: string;
}

export interface ApplyEditsResult {
  readonly path: string;
  readonly previousSha256: string;
  readonly sha256: string;
  readonly changed: boolean;
}

export interface WorkspaceBackend {
  read(path: string, range?: TextRange): Promise<WorkspaceFile>;
  search(query: string, path?: string): Promise<readonly WorkspaceSearchResult[]>;
  applyEdits(path: string, edits: readonly ReplaceEdit[], options?: ApplyEditsOptions): Promise<ApplyEditsResult>;
  write(path: string, content: string, options?: ApplyEditsOptions): Promise<ApplyEditsResult>;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function validateRange(range: TextRange): void {
  if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine) {
    throw new Error("Invalid text range; lines are 1-based and endLine must be >= startLine");
  }
}

export class LocalWorkspace implements WorkspaceBackend {
  private readonly root: string;
  private readonly ignoredDirectories = new Set([".git", "node_modules", "dist", "build", ".next", "coverage"]);
  private readonly maxSearchFileBytes = 1024 * 1024;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  getRoot(): string {
    return this.root;
  }

  resolve(relativePath = "."): string {
    const resolved = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Path escapes the selected workspace");
    }
    return resolved;
  }

  async read(relativePath: string, range?: TextRange): Promise<WorkspaceFile> {
    const target = this.resolve(relativePath);
    const content = await fs.readFile(target, "utf8");
    if (!range) return { path: this.relative(target), content, sha256: sha256(content) };

    validateRange(range);
    const lines = content.split(/\r?\n/);
    const selected = lines.slice(range.startLine - 1, range.endLine).join("\n");
    return { path: this.relative(target), content: selected, sha256: sha256(content), range };
  }

  async search(query: string, relativePath = "."): Promise<readonly WorkspaceSearchResult[]> {
    if (!query.trim()) throw new Error("Search query must not be empty");
    const root = this.resolve(relativePath);
    const results: WorkspaceSearchResult[] = [];

    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (this.ignoredDirectories.has(entry.name)) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(target);
          continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(target);
        if (stat.size > this.maxSearchFileBytes) continue;
        const content = await fs.readFile(target, "utf8").catch(() => "");
        if (!content.includes(query)) continue;
        const lines = content.split(/\r?\n/);
        lines.forEach((line, index) => {
          if (line.includes(query) && results.length < 200) {
            results.push({ path: this.relative(target), line: index + 1, preview: line.trim().slice(0, 240) });
          }
        });
      }
    };

    await walk(root);
    return results;
  }

  async applyEdits(relativePath: string, edits: readonly ReplaceEdit[], options: ApplyEditsOptions = {}): Promise<ApplyEditsResult> {
    if (edits.length === 0) throw new Error("At least one edit is required");
    const target = this.resolve(relativePath);
    const current = await fs.readFile(target, "utf8");
    const previousSha256 = sha256(current);
    if (options.expectedSha256 && options.expectedSha256 !== previousSha256) {
      throw new Error(`Workspace changed before edit: expected ${options.expectedSha256}, found ${previousSha256}`);
    }

    const normalized = [...edits].sort((a, b) => b.start - a.start);
    for (const edit of normalized) {
      if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > current.length) {
        throw new Error(`Invalid edit range for ${relativePath}`);
      }
      if (current.slice(edit.start, edit.end) !== edit.oldText) {
        throw new Error(`Edit precondition failed for ${relativePath} at ${edit.start}`);
      }
    }
    for (let index = 0; index < normalized.length - 1; index += 1) {
      const currentEdit = normalized[index];
      const nextEdit = normalized[index + 1];
      if (!currentEdit || !nextEdit) continue;
      if (nextEdit.end > currentEdit.start) throw new Error(`Overlapping edits for ${relativePath}`);
    }

    let updated = current;
    for (const edit of normalized) updated = `${updated.slice(0, edit.start)}${edit.newText}${updated.slice(edit.end)}`;
    return this.atomicWrite(target, previousSha256, updated);
  }

  async write(relativePath: string, content: string, options: ApplyEditsOptions = {}): Promise<ApplyEditsResult> {
    const target = this.resolve(relativePath);
    const current = await fs.readFile(target, "utf8").catch((error: unknown) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "ENOENT") return undefined;
      throw error;
    });
    if (current === undefined) {
      await this.atomicCreate(target, content);
      const nextSha = sha256(content);
      return { path: this.relative(target), previousSha256: "", sha256: nextSha, changed: true };
    }
    const previousSha256 = sha256(current);
    if (options.expectedSha256 && options.expectedSha256 !== previousSha256) {
      throw new Error(`Workspace changed before write: expected ${options.expectedSha256}, found ${previousSha256}`);
    }
    return this.atomicWrite(target, previousSha256, content);
  }

  private async atomicWrite(target: string, previousSha256: string, content: string): Promise<ApplyEditsResult> {
    if (content === (await fs.readFile(target, "utf8"))) {
      return { path: this.relative(target), previousSha256, sha256: previousSha256, changed: false };
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.agent-tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temp, content, "utf8");
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
    return { path: this.relative(target), previousSha256, sha256: sha256(content), changed: true };
  }

  private async atomicCreate(target: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.agent-tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.writeFile(temp, content, "utf8");
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private relative(target: string): string {
    return path.relative(this.root, target) || ".";
  }
}

export class Workspace {
  private backend: WorkspaceBackend | undefined;

  constructor(backend?: WorkspaceBackend) {
    this.backend = backend;
  }

  use(backend: WorkspaceBackend): void {
    this.backend = backend;
  }

  getBackend(): WorkspaceBackend {
    if (!this.backend) throw new Error("No workspace backend selected");
    return this.backend;
  }

  read(path: string, range?: TextRange): Promise<WorkspaceFile> {
    return this.getBackend().read(path, range);
  }

  search(query: string, path?: string): Promise<readonly WorkspaceSearchResult[]> {
    return this.getBackend().search(query, path);
  }

  applyEdits(path: string, edits: readonly ReplaceEdit[], options?: ApplyEditsOptions): Promise<ApplyEditsResult> {
    return this.getBackend().applyEdits(path, edits, options);
  }

  write(path: string, content: string, options?: ApplyEditsOptions): Promise<ApplyEditsResult> {
    return this.getBackend().write(path, content, options);
  }
}
