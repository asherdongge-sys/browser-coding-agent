import type { Page } from "playwright";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { ensureGitHubSelectedV2 } from "./github-app-selector-v2.js";
import { startChatGPTPageSync, stopChatGPTPageSync } from "./chatgpt-page-sync.js";

type Managed = { id: string; page: Page; status?: string; conversationUrl?: string; lastError?: string; updatedAt?: number; messages?: unknown[] };
type ProviderPrototype = {
  createAgent(title: string, prompt: string): Promise<unknown>;
  resumeAgent(agentId: string): Promise<unknown>;
  initializeAgent(agent: Managed): Promise<void>;
  stop(): Promise<void>;
  submitComposer(page: Page, text: string): Promise<void>;
  selectChatGPTApp(page: Page, appName: string): Promise<boolean>;
  agents?: Map<string, Managed>;
  initialization?: Map<string, Promise<void>>;
  onEvent?: (event: unknown) => void;
};

const provider = PlaywrightBrowserProvider.prototype as unknown as ProviderPrototype;
const nativeCreateAgent = provider.createAgent;

async function findComposer(page: Page) {
  const selectors = ["[contenteditable='true']:not([aria-hidden='true'])","textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)","textarea:not(.wcDTda_fallbackTextarea)","[role='textbox']:not([aria-hidden='true'])"];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    for (let index = await locator.count() - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

async function isChatGPTPage(page: Page): Promise<boolean> {
  try {
    const url = new URL(page.url());
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && !/^\/(apps|gpts)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

function patchAgent(self: unknown, agentId: string, changes: Record<string, unknown>): void {
  const target = self as { agents?: Map<string, Managed>; onEvent?: (event: unknown) => void };
  const agent = target.agents?.get(agentId);
  if (!agent) return;
  Object.assign(agent, changes, { updatedAt: Date.now() });
  target.onEvent?.({ type: "agent.updated", agent: { ...agent } });
}

provider.createAgent = async function createAgent(title: string, prompt: string): Promise<unknown> {
  const self = this as unknown as ProviderPrototype;
  const agent = await nativeCreateAgent.call(this, title, prompt) as Managed;
  const initialization = self.initialization?.get(agent.id);
  if (initialization) await initialization;
  return agent;
};

provider.initializeAgent = async function initializeAgent(agent: Managed): Promise<void> {
  try {
    patchAgent(this, agent.id, { status: "opening-chatgpt", lastError: "" });
    if (agent.page.isClosed()) throw new Error("Agent browser page is unavailable");
    if (!await isChatGPTPage(agent.page)) {
      await agent.page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    }
    const deadline = Date.now() + 45000;
    let composer = await findComposer(agent.page);
    while (!composer && Date.now() < deadline) {
      if (!await isChatGPTPage(agent.page)) {
        await agent.page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
      }
      composer = await findComposer(agent.page);
      if (!composer) await agent.page.waitForTimeout(300);
    }
    if (!composer) {
      const body = await agent.page.locator("body").innerText().catch(() => "");
      const loginRequired = /log in|sign in|登录|注册/i.test(body) || /\/auth\//i.test(agent.page.url());
      patchAgent(this, agent.id, { status: loginRequired ? "login-required" : "failed", conversationUrl: agent.page.url(), lastError: loginRequired ? "请先在托管的 Chromium 中完成 ChatGPT 登录。" : "ChatGPT composer did not become ready within 45s" });
      return;
    }
    patchAgent(this, agent.id, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
    const target = this as unknown as { onEvent?: (event: unknown) => void; patch?: (agent: Managed, changes: Record<string, unknown>) => void };
    const emit = target.onEvent as ((event: any) => void) | undefined;
    const patch = (changes: Partial<Managed>) => patchAgent(this, agent.id, changes as Record<string, unknown>);
    if (emit) await startChatGPTPageSync(agent as unknown as any, agent.page, emit as any, patch as any);
  } catch (error) {
    patchAgent(this, agent.id, { status: "failed", lastError: error instanceof Error ? error.message : String(error), conversationUrl: agent.page.url() });
  }
};

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return false;
  if (!await isChatGPTPage(page)) return false;
  return ensureGitHubSelectedV2(page, appName);
};