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
  submitComposerAfterAppSelection(page: Page, text: string): Promise<void>;
  selectChatGPTApp(page: Page, appName: string): Promise<boolean>;
  emit(event: any): void;
  agents?: Map<string, Managed>;
  initialization?: Map<string, Promise<void>>;
  onEvent?: (event: unknown) => void;
};

const provider = PlaywrightBrowserProvider.prototype as unknown as ProviderPrototype;
const nativeCreateAgent = provider.createAgent;
const nativeSubmitComposerAfterAppSelection = provider.submitComposerAfterAppSelection;
const nativeEmit = provider.emit;

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

provider.emit = function emit(event: any): void {
  // The native provider already maintains the assistant message while ChatGPT
  // streams. The page sync publishes the final stable manual/assistant turn.
  // Suppress native streaming events so the dashboard cannot render each DOM
  // fragment as a separate assistant message.
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
    const target = this as unknown as { onEvent?: (event: unknown) => void };
    const emit = target.onEvent as ((event: any) => void) | undefined;
    const patch = (changes: Partial<Managed>) => patchAgent(this, agent.id, changes as Record<string, unknown>);
    if (emit) await startChatGPTPageSync(agent as unknown as any, agent.page, emit as any, patch as any);
  } catch (error) {
    patchAgent(this, agent.id, { status: "failed", lastError: error instanceof Error ? error.message : String(error), conversationUrl: agent.page.url() });
  }
};

provider.submitComposerAfterAppSelection = async function submitComposerAfterAppSelection(page: Page, text: string): Promise<void> {
  const composer = await findComposer(page);
  if (!composer) throw new Error("ChatGPT composer is not visible after selecting GitHub");
  // Do not click the composer here. ChatGPT app mentions are represented as a
  // special inline token, and clicking can move the caret to the wrong node or
  // cause the token to be discarded. Preserve the focus created by Space.
  await composer.focus({ timeout: 5000 });
  const active = await page.evaluate(() => document.activeElement?.matches("[contenteditable='true'], textarea, [role='textbox']") ?? false).catch(() => false);
  if (!active) throw new Error("ChatGPT composer lost focus after selecting GitHub");
  await page.keyboard.type(text, { delay: 5 });
  for (const selector of ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]', 'button[type="submit"]']) {
    const buttons = page.locator(selector);
    for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      if (await button.isDisabled().catch(() => true)) continue;
      await button.click({ timeout: 5000 });
      return;
    }
  }
  await page.keyboard.press("Enter");
};

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return false;
  if (!await isChatGPTPage(page)) return false;
  return ensureGitHubSelectedV2(page, appName);
};