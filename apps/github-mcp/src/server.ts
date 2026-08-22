import { createInterface } from "node:readline";

const token = process.env.GITHUB_TOKEN;
const apiBase = "https://api.github.com";

const tools = [
  { name: "github.list_repositories", description: "List repositories visible to the configured GitHub account.", inputSchema: { type: "object", properties: { page: { type: "number" }, perPage: { type: "number" } } } },
  { name: "github.search_repositories", description: "Search GitHub repositories by name or description.", inputSchema: { type: "object", properties: { query: { type: "string" }, perPage: { type: "number" } }, required: ["query"] } },
  { name: "github.get_file", description: "Read a file from a GitHub repository.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["owner", "repo", "path"] } },
  { name: "github.get_issue", description: "Get a GitHub issue or pull request by number.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } }, required: ["owner", "repo", "number"] } },
  { name: "github.get_pull_request", description: "Get pull request metadata and changed files.", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } }, required: ["owner", "repo", "number"] } },
] as const;

async function github(path: string, init?: RequestInit): Promise<any> {
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const response = await fetch(`${apiBase}${path}`, { ...init, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", ...(init?.headers ?? {}) } });
  const text = await response.text();
  let body: any; try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${typeof body === "string" ? body : body?.message ?? JSON.stringify(body)}`);
  return body;
}

async function call(name: string, args: any): Promise<any> {
  if (name === "github.list_repositories") {
    const page = Math.max(1, Number(args?.page ?? 1)); const perPage = Math.min(100, Math.max(1, Number(args?.perPage ?? 30)));
    return github(`/user/repos?sort=updated&per_page=${perPage}&page=${page}`);
  }
  if (name === "github.search_repositories") {
    const query = encodeURIComponent(String(args?.query ?? "")); const perPage = Math.min(100, Math.max(1, Number(args?.perPage ?? 20)));
    return github(`/search/repositories?q=${query}&per_page=${perPage}`);
  }
  if (name === "github.get_file") {
    const ref = args?.ref ? `?ref=${encodeURIComponent(String(args.ref))}` : "";
    const body = await github(`/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${String(args.path).split("/").map(encodeURIComponent).join("/")}${ref}`);
    if (Array.isArray(body)) return body;
    if (body.content && body.encoding === "base64") return { ...body, decodedContent: Buffer.from(body.content, "base64").toString("utf8") };
    return body;
  }
  if (name === "github.get_issue") return github(`/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${Number(args.number)}`);
  if (name === "github.get_pull_request") return github(`/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${Number(args.number)}`);
  throw new Error(`Unknown tool: ${name}`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let request: any; try { request = JSON.parse(line); } catch { return; }
  if (request.method === "notifications/initialized") return;
  if (request.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "browser-coding-agent-github", version: "0.1.0" } } }) + "\n"); return;
  }
  try {
    if (request.method === "tools/list") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools } }) + "\n");
    else if (request.method === "tools/call") { const result = await call(request.params?.name, request.params?.arguments ?? {}); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] } }) + "\n"); }
    else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] } }) + "\n"); }
});
