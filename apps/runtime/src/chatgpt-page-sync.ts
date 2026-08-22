import type { Page } from "playwright";
import type { BrowserAgent, BrowserAgentMessage, BrowserAgentEvent } from "./browser-provider.js";

type Snapshot = { text: string; count: number };
type SyncState = {
  timer: ReturnType<typeof setInterval>;
  user: Snapshot;
  assistant: Snapshot;
  pendingAssistant: string;
  assistantStableSince: number;
  syncRunning: boolean;
};

const states = new Map<string, SyncState>();
const ASSISTANT_STABILITY_MS = 900;

async function snapshot(page: Page, role: "user" | "assistant"): Promise<Snapshot> {
  try {
    return await page.evaluate((messageRole) => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(
        `[data-message-author-role='${messageRole}']`,
      ));
      const texts = nodes
        .map((node) => (node.innerText || node.textContent || "").trim())
        .filter(Boolean);
      return { text: texts.at(-1) ?? "", count: texts.length };
    }, role);
  } catch {
    return { text: "", count: 0 };
  }
}

function hasMessage(agent: BrowserAgent, role: BrowserAgentMessage["role"], text: string): boolean {
  const normalized = text.trim();
  return Boolean(normalized) && (agent.messages ?? []).some(
    (message) => message.role === role && message.text.trim() === normalized,
  );
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
  const state: SyncState = {
    timer: undefined as unknown as ReturnType<typeof setInterval>,
    user: initialUser,
    assistant: initialAssistant,
    pendingAssistant: "",
    assistantStableSince: 0,
    syncRunning: false,
  };
  state.timer = setInterval(() => {
    if (state.syncRunning) return;
    state.syncRunning = true;
    void syncOnce(agent, page, state, emit, patch).finally(() => {
      state.syncRunning = false;
    });
  }, 900);
  states.set(agent.id, state);
}

async function syncOnce(
  agent: BrowserAgent,
  page: Page,
  state: SyncState,
  emit: (event: BrowserAgentEvent) => void,
  patch: (patch: Partial<BrowserAgent>) => void,
): Promise<void> {
  if (page.isClosed()) {
    stopChatGPTPageSync(agent.id);
    return;
  }

  const user = await snapshot(page, "user");
  const assistant = await snapshot(page, "assistant");

  if (user.count > state.user.count || (user.text && user.text !== state.user.text)) {
    if (user.text && !hasMessage(agent, "user", user.text)) {
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

  // ChatGPT renders assistant responses incrementally. Do not publish every
  // DOM fragment to the dashboard. Wait until the text has stopped changing.
  if (
    state.pendingAssistant &&
    state.assistantStableSince > 0 &&
    Date.now() - state.assistantStableSince >= ASSISTANT_STABILITY_MS
  ) {
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
