import type { Page } from "playwright";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { ensureGitHubSelectedV2, submitMessageAfterGitHubSelection } from "./github-app-selector-v2.js";
import { startChatGPTPageSync } from "./chatgpt-page-sync.js";

type Managed = { id: string; page: Page; status?: string; conversationUrl?: string; lastError?: string; updatedAt?: number; messages?: unknown[] };
type ProviderPrototype = {
  createAgent(title: string, prompt: string): Promise<unknown>;
  initializeAgent(agent: Managed): Promise<void>;
  submitComposerAfterAppSelection(page: Page, text: string): Promise<void>;
  selectChatGPTApp(page: Page, appName: string): Promise<boolean>;
  emit(event: any): void;
  agents?: Map<string, Managed>;
  initialization?: Map<string, Promise<void>>;
  onEvent?: (event: unknown) => void;
};

const provider = PlaywrightBrowserProvider.prototype as unknown as ProviderPrototype;
const nativeCreateAgent = provider.createAgent;
const nativeEmit = provider.emit;

async function findComposer(page: Page) {
  const selectors = [
    "[contenteditable='true']:not([aria-hidden='true'])",
    "textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)",
    "textarea:not(.wcDTda_fallbackTextarea)",
    "[role='textbox']:not([aria-hidden='true'])",
  ];
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

function agentForPage(self: unknown, page: Page): Managed | undefined {
  const target = self as { agents?: Map<string, Managed> };
  for (const agent of target.agents?.values() ?? []) if (agent.page === page) return agent;
  return undefined;
}

provider.emit = function emit(event: any): void {
  if (event?.streaming === true) return;
  nativeEmit.call(this, event);
};

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

    // Navigate at most once. Repeated goto() calls while ChatGPT is restoring
    // the conversation can trigger rate limits and destroy the JS context.
    if (!await isChatGPTPage(agent.page)) {
      await agent.page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    }

    const deadline = Date.now() + 45000;
    let composer = await findComposer(agent.page);
    while (!composer && Date.now() < deadline) {
      if (!await isChatGPTPage(agent.page)) {
        patchAgent(this, agent.id, { status: "failed", conversationUrl: agent.page.url(), lastError: "ChatGPT navigated away while initializing; please retry after the page settles." });
        return;
      }
      composer = await findComposer(agent.page);
      if (!composer) await agent.page.waitForTimeout(500);
    }

    if (!composer) {
      const body = await agent.page.locator("body").innerText().catch(() => "");
      const loginRequired = /log in|sign in|登录|注册/i.test(body) || /\/auth\//i.test(agent.page.url());
      patchAgent(this, agent.id, {
        status: loginRequired ? "login-required" : "failed",
        conversationUrl: agent.page.url(),
        lastError: loginRequired ? "请先在托管的 Chromium 中完成 ChatGPT 登录。" : "ChatGPT composer did not become ready within 45s",
      });
      return;
    }

    patchAgent(this, agent.id, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
    const emit = (this as unknown as { onEvent?: (event: unknown) => void }).onEvent as ((event: any) => void) | undefined;
    const patch = (changes: Partial<Managed>) => patchAgent(this, agent.id, changes as Record<string, unknown>);
    if (emit) await startChatGPTPageSync(agent as unknown as any, agent.page, emit as any, patch as any);
  } catch (error) {
    patchAgent(this, agent.id, { status: "failed", lastError: error instanceof Error ? error.message : String(error), conversationUrl: agent.page.url() });
  }
};

provider.submitComposerAfterAppSelection = async function submitComposerAfterAppSelection(page: Page, text: string): Promise<void> {
  // The selector stores the exact composer that committed the GitHub mention.
  // Reusing it avoids the ChatGPT editor turning the mention into plain text
  // or dropping the chip when focus is moved between two DOM locators.
  await submitMessageAfterGitHubSelection(page, text);
};

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return false;
  if (!await isChatGPTPage(page)) return false;
  const selected = await ensureGitHubSelectedV2(page, appName);
  const agent = agentForPage(this, page);
  if (agent) {
    patchAgent(this, agent.id, selected
      ? { status: "idle", lastError: "", conversationUrl: page.url() }
      : { status: "failed", lastError: "GitHub App initialization failed", conversationUrl: page.url() });
  }
  return selected;
};
