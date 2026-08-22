import type { Page } from "playwright";
import type { BrowserAgent, BrowserAgentMessage, BrowserAgentEvent } from "./browser-provider.js";

type Snapshot = { text: string; count: number };
type SyncState = { timer: ReturnType<typeof setInterval>; user: Snapshot; assistant: Snapshot };

const states = new Map<string, SyncState>();

async function snapshot(page: Page, role: "user" | "assistant"): Promise<Snapshot> {
  try {
    return await page.evaluate((messageRole) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(`[data-message-author-role='${messageRole}']`));
      const texts = [...new Set(nodes)].map((node) => (node.innerText || node.textContent || "").trim()).filter(Boolean);
      return { text: texts.at(-1) ?? "", count: texts.length };
    }, role);
  } catch {
    return { text: "", count: 0 };
  }
}

function hasMessage(agent: BrowserAgent, role: BrowserAgentMessage["role"], text: string): boolean {
  return Boolean(text.trim()) && (agent.messages ?? []).some((message) => message.role === role && message.text.trim() === text.trim());
}

export async function startChatGPTPageSync(
  agent: BrowserAgent,
  page: Page,
  emit: (event: BrowserAgentEvent) => void,
  patch: (patch: Partial<BrowserAgent>) => void,
): Promise<void> {
  stopChatGPTPageSync(agent.id);
  const initialUser = await snapshot(page, "user");
  const initialAssistant = await snapshot(page, "assistant");
  const state: SyncState = { timer: setInterval(() => { void syncOnce(agent, page, state, emit, patch); }, 900), user: initialUser, assistant: initialAssistant };
  states.set(agent.id, state);
}

async function syncOnce(
  agent: BrowserAgent,
  page: Page,
  state: SyncState,
  emit: (event: BrowserAgentEvent) => void,
  patch: (patch: Partial<BrowserAgent>) => void,
): Promise<void> {
  if (page.isClosed()) { stopChatGPTPageSync(agent.id); return; }
  const user = await snapshot(page, "user");
  const assistant = await snapshot(page, "assistant");
  if (user.count > state.user.count || user.text !== state.user.text) {
    if (user.text && !hasMessage(agent, "user", user.text)) {
      agent.messages = agent.messages ?? [];
      agent.messages.push({ role: "user", text: user.text, createdAt: Date.now() });
      emit({ type: "agent.message", agentId: agent.id, role: "user", text: user.text, url: page.url(), createdAt: Date.now(), streaming: false });
    }
    state.user = user;
  }
  if (assistant.count > state.assistant.count || assistant.text !== state.assistant.text) {
    if (assistant.text && !hasMessage(agent, "assistant", assistant.text)) {
      agent.messages = agent.messages ?? [];
      const last = agent.messages.at(-1);
      if (last?.role === "assistant") last.text = assistant.text;
      else agent.messages.push({ role: "assistant", text: assistant.text, createdAt: Date.now() });
      emit({ type: "agent.message", agentId: agent.id, role: "assistant", text: assistant.text, url: page.url(), createdAt: Date.now(), streaming: false });
      patch({ status: "idle", conversationUrl: page.url(), lastError: "" });
    }
    state.assistant = assistant;
  }
}

export function stopChatGPTPageSync(agentId: string): void {
  const state = states.get(agentId);
  if (!state) return;
  clearInterval(state.timer);
  states.delete(agentId);
}
