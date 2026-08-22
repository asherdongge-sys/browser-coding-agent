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
};

const provider = PlaywrightBrowserProvider.prototype as unknown as ProviderPrototype;

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

// Make readiness deterministic. The native implementation can race ChatGPT navigation;
// this version owns the transition out of opening-chatgpt and reports failures explicitly.
provider.initializeAgent = async function initializeAgent(agent: Managed): Promise<void> {
  const self = this as unknown;
  try {
    patchAgent(self, agent.id, { status: "opening-chatgpt", lastError: "" });
    if (!agent.page.isClosed() && !await isChatGPTPage(agent.page)) {
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
      patchAgent(self, agent.id, { status: loginRequired ? "login-required" : "failed", conversationUrl: agent.page.url(), lastError: loginRequired ? "请先在托管的 Chromium 中完成 ChatGPT 登录。" : "ChatGPT composer did not become ready within 45s" });
      return;
    }
    patchAgent(self, agent.id, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
  } catch (error) {
    patchAgent(self, agent.id, { status: "failed", lastError: error instanceof Error ? error.message : String(error), conversationUrl: agent.page.url() });
  }
};

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return false;
  if (!await isChatGPTPage(page)) return false;
  return ensureGitHubSelectedV2(page, appName);
};

const originalCreateAgent = provider.createAgent;
provider.createAgent = async function createAgent(title: string, prompt: string): Promise<unknown> {
  const agent = await originalCreateAgent.call(this, title, prompt) as Managed;
  try { await provider.resumeAgent.call(this, agent.id); } catch { /* initializeAgent already reported the state */ }
  const self = this as unknown as { agents?: Map<string, Managed>; onEvent?: (event: unknown) => void };
  const managed = self.agents?.get(agent.id) ?? agent;
  if (managed.status === "failed" || managed.status === "login-required") return agent;
  if (await isChatGPTPage(managed.page)) {
    const githubSelected = await ensureGitHubSelectedV2(managed.page, "GitHub").catch(() => false);
    if (!githubSelected) patchAgent(self, agent.id, { status: "failed", lastError: "GitHub App could not be selected during agent initialization" });
  }
  await startChatGPTPageSync(managed as never, managed.page, (self.onEvent ?? (() => undefined)) as never, ((changes: Record<string, unknown>) => patchAgent(self, agent.id, changes)) as never).catch(() => undefined);
  return agent;
};

const originalStop = provider.stop;
provider.stop = async function stop(): Promise<void> {
  for (const agent of this.agents?.values() ?? []) stopChatGPTPageSync(agent.id);
  return originalStop.call(this);
};

provider.submitComposer = async function submitComposer(page: Page, text: string): Promise<void> {
  const composer = await findComposer(page);
  if (!composer) throw new Error("ChatGPT composer is not visible");
  if (!await isChatGPTPage(page)) throw new Error("ChatGPT page navigated away from the conversation");
  await composer.click({ timeout: 5000 });
  await composer.fill(text);
  await page.waitForFunction((expected) => Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']")).some((node) => {
    const style = window.getComputedStyle(node); const rect = node.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0 || node.classList.contains("wcDTda_fallbackTextarea")) return false;
    const value = node instanceof HTMLTextAreaElement ? node.value : node.innerText || node.textContent || "";
    return value.trim() === String(expected).trim();
  }), text, { timeout: 5000 });
  for (const selector of ["button[data-testid='send-button']","button[aria-label*='Send' i]","button[aria-label*='发送' i]","button[type='submit']"]) {
    const buttons = page.locator(selector);
    for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      if (await button.isDisabled().catch(() => true)) continue;
      await button.click({ timeout: 5000 });
      return;
    }
  }
  await composer.press("Enter");
};
