import type { McpStdioClient } from "@browser-coding-agent/mcp";

export type GitHubMcpRoute = { tool: string; arguments: Record<string, unknown> };

export function planGitHubMcpRoute(text: string): GitHubMcpRoute | undefined {
  const value = text.trim();
  if (!/github/i.test(value) && !/仓库|代码仓库|pull request|拉取请求|issue|提交|commit|分支/.test(value)) return undefined;
  if (/(?:前\s*\d+|top\s*\d+|列表|list|有哪些|我有权限访问)/i.test(value) && /仓库|repositories?|repos?/i.test(value)) {
    const match = value.match(/(?:前|top)\s*(\d+)/i);
    const perPage = Math.min(50, Math.max(1, Number(match?.[1] ?? 5)));
    return { tool: "github.list_repositories", arguments: { page: 1, perPage } };
  }
  const search = value.match(/(?:搜索|查找|search)\s*(?:github\s*)?(?:仓库|repositories?|repos?)?\s*[：:]?\s*[“\"]?([^”\"，。]+)[”\"]?/i);
  if (search?.[1]) return { tool: "github.search_repositories", arguments: { query: search[1].trim(), perPage: 10 } };
  return undefined;
}

export async function executeGitHubMcpRoute(client: McpStdioClient, route: GitHubMcpRoute): Promise<unknown> {
  const result = await client.callTool(route.tool, route.arguments);
  if (result.isError) throw new Error(JSON.stringify(result.content ?? result));
  return result.structuredContent ?? result.content ?? result;
}

export function formatGitHubMcpContext(route: GitHubMcpRoute, result: unknown): string {
  return [
    "本次请求已经由 Browser Coding Agent 本地 Runtime 通过 GitHub MCP 执行。",
    `本地 MCP 工具：${route.tool}`,
    "请只根据下面的 MCP 返回结果回答用户，不要调用任何 GitHub Connector 或其他外部工具。",
    "MCP 返回结果：",
    JSON.stringify(result),
  ].join("\n");
}
