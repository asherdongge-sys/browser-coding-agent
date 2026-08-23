import type { McpStdioClient } from "@browser-coding-agent/mcp";

export type GitHubMcpRoute = { tool: string; arguments: Record<string, unknown> };

const INTERNAL_MCP_PREFIX = "::github-mcp-internal::";

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

function compactGitHubResult(route: GitHubMcpRoute, result: unknown): unknown {
  const records = Array.isArray(result) ? result : undefined;
  if (!records) return result;
  if (route.tool === "github.list_repositories") {
    return records.slice(0, 50).map((item) => {
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { name: value.name, full_name: value.full_name, private: value.private };
    });
  }
  if (route.tool === "github.search_repositories") {
    return records.slice(0, 20).map((item) => {
      const value = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { name: value.name, full_name: value.full_name, description: value.description };
    });
  }
  return records;
}

export function formatGitHubMcpContext(route: GitHubMcpRoute, result: unknown): string {
  return [
    INTERNAL_MCP_PREFIX,
    "根据下面的 GitHub MCP 结果直接回答用户原始问题。只输出最终答案，不要提及 MCP、工具调用、执行过程或内部上下文。",
    `工具结果：${JSON.stringify(compactGitHubResult(route, result))}`,
  ].join("\n");
}

export function isInternalGitHubMcpMessage(text: string): boolean {
  return text.trimStart().startsWith(INTERNAL_MCP_PREFIX);
}
