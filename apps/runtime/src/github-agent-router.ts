import type { McpStdioClient } from "@browser-coding-agent/mcp";

export type GitHubMcpRoute = { tool: string; arguments: Record<string, unknown>; originalUserMessage: string };

const INTERNAL_MCP_PREFIX = "::github-mcp-internal::";
const ORIGINAL_MESSAGE_PREFIX = "ORIGINAL_USER_MESSAGE_JSON:";
const INTERNAL_MCP_HINT = "根据下面的 GitHub MCP 结果直接回答用户原始问题";
const INTERNAL_MCP_RESULT_HINT = "工具结果：";

export function planGitHubMcpRoute(text: string): GitHubMcpRoute | undefined {
  const value = text.trim();
  if (!/github/i.test(value) && !/仓库|代码仓库|pull request|拉取请求|issue|提交|commit|分支/.test(value)) return undefined;
  if (/(?:前\s*\d+|top\s*\d+|列表|list|有哪些|我有权限访问)/i.test(value) && /仓库|repositories?|repos?/i.test(value)) {
    const match = value.match(/(?:前|top)\s*(\d+)/i);
    const perPage = Math.min(50, Math.max(1, Number(match?.[1] ?? 5)));
    return { tool: "github.list_repositories", arguments: { page: 1, perPage }, originalUserMessage: text };
  }
  const search = value.match(/(?:搜索|查找|search)\s*(?:github\s*)?(?:仓库|repositories?|repos?)?\s*[：:]?\s*[“\"]?([^”\"，。]+)[”\"]?/i);
  if (search?.[1]) return { tool: "github.search_repositories", arguments: { query: search[1].trim(), perPage: 10 }, originalUserMessage: text };
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

/**
 * GitHub MCP execution is intentionally kept out of the ChatGPT conversation.
 * The runtime already has the structured result, so for the currently supported
 * GitHub routes we can produce the final user-facing answer deterministically.
 * This prevents internal prompts/tool payloads from becoming user messages.
 */
export function formatGitHubFinalAnswer(route: GitHubMcpRoute, result: unknown): string {
  const compact = compactGitHubResult(route, result);
  if (!Array.isArray(compact)) return typeof compact === "string" ? compact : JSON.stringify(compact);

  if (route.tool === "github.list_repositories") {
    const names = compact
      .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
      .filter((item) => typeof item.name === "string")
      .map((item) => String(item.name));
    if (!names.length) return "当前没有查询到可访问的 GitHub 仓库。";
    return `你有权限访问的仓库前 ${names.length} 个如下：\n\n${names.map((name, index) => `${index + 1}. **${name}**`).join("\n")}`;
  }

  if (route.tool === "github.search_repositories") {
    const rows = compact
      .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
      .filter((item) => typeof item.name === "string")
      .map((item, index) => `${index + 1}. **${String(item.name)}**${typeof item.full_name === "string" ? ` — \`${item.full_name}\`` : ""}`);
    return rows.length ? `找到 ${rows.length} 个相关仓库：\n\n${rows.join("\n")}` : "没有找到相关 GitHub 仓库。";
  }

  return JSON.stringify(compact);
}

export function formatGitHubMcpContext(route: GitHubMcpRoute, result: unknown): string {
  return [
    INTERNAL_MCP_PREFIX,
    `${ORIGINAL_MESSAGE_PREFIX}${JSON.stringify(route.originalUserMessage)}`,
    `${INTERNAL_MCP_HINT}。只输出最终答案，不要提及 MCP、工具调用、执行过程或内部上下文。`,
    `${INTERNAL_MCP_RESULT_HINT}${JSON.stringify(compactGitHubResult(route, result))}`,
  ].join("\n");
}

export function parseGitHubMcpContext(text: string): { modelText: string; displayText: string } | undefined {
  const value = text.trimStart();
  if (!value.startsWith(INTERNAL_MCP_PREFIX)) return undefined;
  const line = value.split("\n").find((item) => item.startsWith(ORIGINAL_MESSAGE_PREFIX));
  if (!line) return undefined;
  try {
    const displayText = JSON.parse(line.slice(ORIGINAL_MESSAGE_PREFIX.length));
    if (typeof displayText !== "string" || !displayText.trim()) return undefined;
    return { modelText: text, displayText };
  } catch {
    return undefined;
  }
}

export function isInternalGitHubMcpMessage(text: string): boolean {
  const value = text.trim();
  return value.includes(INTERNAL_MCP_PREFIX) || value.includes(ORIGINAL_MESSAGE_PREFIX) || value.includes(INTERNAL_MCP_HINT) || value.includes(INTERNAL_MCP_RESULT_HINT);
}

export function getGitHubDisplayMessage(text: string): string | undefined {
  const parsed = parseGitHubMcpContext(text);
  return parsed?.displayText;
}
