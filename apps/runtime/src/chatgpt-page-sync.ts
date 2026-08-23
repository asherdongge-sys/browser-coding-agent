import type { Page } from "playwright";
import type { BrowserAgent, BrowserAgentMessage, BrowserAgentEvent } from "./browser-provider.js";
import { getGitHubDisplayMessage, isInternalGitHubMcpMessage } from "./github-agent-router.js";

type Snapshot = { text: string; count: number };
type SyncState = { timer: ReturnType<typeof setInterval>; user: Snapshot; assistant: Snapshot; pendingAssistant: string; assistantStableSince: number; syncRunning: boolean };

const states = new Map<string, SyncState>();
const POLL_INTERVAL_MS = 500;
const ASSISTANT_STABILITY_MS = 1200;

async function sanitizeInternalUserMessages(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='user']"));
      for (const node of nodes) {
        const text = (node.innerText || node.textContent || "").trim();
        if (!text.includes("::github-mcp-internal::") && !text.includes("ORIGINAL_USER_MESSAGE_JSON:") && !text.includes("根据下面的 GitHub MCP 结果") && !text.includes("工具结果：")) continue;
        const match = text.match(/ORIGINAL_USER_MESSAGE_JSON:([^\n]+)/);
        if (match?.[1]) {
          try {
            const displayText = JSON.parse(match[1]);
            if (typeof displayText === "string" && displayText.trim()) {
              const target = node.querySelector<HTMLElement>(".whitespace-pre-wrap, [class*='whitespace-pre-wrap']") ?? node;
              target.textContent = displayText;
              continue;
            }
          } catch { /* keep hidden below */ }
        }
        node.style.display = "none";
      }
    });
  } catch { /* page may be navigating */ }
}

async function snapshot(page: Page, role: "user" | "assistant"): Promise<Snapshot> {
  try {
    if (role === "user") await sanitizeInternalUserMessages(page);
    return await page.evaluate((messageRole) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-message-author-role='${messageRole}']`));
      const texts = nodes.map((node) => (node.innerText || node.textContent || "").trim()).filter(Boolean);
      return { text: texts.at(-1) ?? "", count: texts.length };
    }, role);
  } catch { return { text: "", count: 0 }; }
}

function hasMessage(agent: BrowserAgent, role: BrowserAgentMessage["role"], text: string): boolean {
  const normalized = text.trim();
  return Boolean(normalized) && (agent.messages ?? []).some((message) => message.role === role && message.text.trim() === normalized);
}

export async function startChatGPTPageSync(agent: BrowserAgent, page: Page, emit: (event: BrowserAgentEvent) => void, patch: (patch: Partial<BrowserAgent>) => void): Promise<void> {
  stopChatGPTPageSync(agent.id);
  await sanitizeInternalUserMessages(page);
  const initialUser = await snapshot(page, "user");
  const initialAssistant = await snapshot(page, "assistant");
  const state: SyncState = { timer: undefined as unknown as ReturnType<typeof setInterval>, user: initialUser, assistant: initialAssistant, pendingAssistant: "", assistantStableSince: 0, syncRunning: false };
  state.timer = setInterval(() => {
    if (state.syncRunning) return;
    state.syncRunning = true;
    void syncOnce(agent, page, state, emit, patch).finally(() => { state.syncRunning = false; });
  }, POLL_INTERVAL_MS);
  states.set(agent.id, state);
}

async function syncOnce(agent: BrowserAgent, page: Page, state: SyncState, emit: (event: BrowserAgentEvent) => void, patch: (patch: Partial<BrowserAgent>) => void): Promise<void> {
  if (page.isClosed()) { stopChatGPTPageSync(agent.id); return; }
  const user = await snapshot(page, "user");
  const assistant = await snapshot(page, "assistant");

  if (user.count > state.user.count || (user.text && user.text !== state.user.text)) {
    if (user.text && !isInternalGitHubMcpMessage(user.text) && !hasMessage(agent, "user", user.text)) {
      const createdAt = Date.now();
      agent.messages = agent.messages ?? [];
      agent.messages.push({ role: "user", text: user.text, createdAt });
      emit({ type: "agent.message", agentId: agent.id, role: "user", text: user.text, url: page.url(), createdAt, streaming: false });
    }
    state.user = user;
  }

  if (assistant.count > state.assistant.count || assistant.text !== state.assistant.text) {
    if (assistant.text !== state.pendingAssistant) {
      state.pendingAssistant = assistant.text;
      state.assistantStableSince = assistant.text ? Date.now() : 0;
    }
    state.assistant = assistant;
  }

  if (state.pendingAssistant && state.assistantStableSince > 0 && Date.now() - state.assistantStableSince >= ASSISTANT_STABILITY_MS) {
    const text = state.pendingAssistant;
    state.pendingAssistant = "";
    state.assistantStableSince = 0;
    const last = agent.messages?.at(-1);
    if (last?.role === "assistant") {
      if (last.text.trim() === text.trim()) return;
      last.text = text;
      emit({ type: "agent.message", agentId: agent.id, role: "assistant", text, url: page.url(), createdAt: last.createdAt, streaming: false });
    } else if (!hasMessage(agent, "assistant", text)) {
      const createdAt = Date.now();
      agent.messages = agent.messages ?? [];
      agent.messages.push({ role: "assistant", text, createdAt });
      emit({ type: "agent.message", agentId: agent.id, role: "assistant", text, url: page.url(), createdAt, streaming: false });
    }
    patch({ status: "idle", conversationUrl: page.url(), lastError: "" });
  }
}

export function stopChatGPTPageSync(agentId: string): void {
  const state = states.get(agentId);
  if (!state) return;
  clearInterval(state.timer);
  states.delete(agentId);
}
