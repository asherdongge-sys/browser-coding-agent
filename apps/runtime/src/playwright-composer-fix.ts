import type { Page } from "playwright";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { ensureGitHubSelectedV2 } from "./github-app-selector-v2.js";
import { startChatGPTPageSync, stopChatGPTPageSync } from "./chatgpt-page-sync.js";

type ProviderPrototype = {
  createAgent(title: string, prompt: string): Promise<unknown>;
  resumeAgent(agentId: string): Promise<unknown>;
  stop(): Promise<void>;
  submitComposer(page: Page, text: string): Promise<void>;
  selectChatGPTApp(page: Page, appName: string): Promise<boolean>;
  agents?: Map<string, { id: string; page: Page; messages?: unknown[] }>;
};

const provider = PlaywrightBrowserProvider.prototype as unknown as ProviderPrototype;

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
  const url = page.url();
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(url) && !/^\/(apps|gpts)(?:\/|$)/i.test(new URL(url).pathname);
}

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return false;
  if (!await isChatGPTPage(page)) return false;
  return ensureGitHubSelectedV2(page, appName);
};

const originalCreateAgent = provider.createAgent;
provider.createAgent = async function createAgent(title: string, prompt: string): Promise<unknown> {
  const agent = await originalCreateAgent.call(this, title, prompt) as { id: string; page: Page };

  // The native provider initializes asynchronously. Always wait for that
  // lifecycle first, then attach the default GitHub app before createAgent
  // resolves. This makes both "send immediately" and "send later" follow the
  // same ordering: ChatGPT ready -> GitHub selected -> agent ready.
  await provider.resumeAgent.call(this, agent.id).catch(() => undefined);

  const self = this as unknown as {
    agents?: Map<string, { id: string; page: Page; messages?: unknown[] }>;
    onEvent?: (event: unknown) => void;
  };
  const managed = self.agents?.get(agent.id) ?? agent;

  if (await isChatGPTPage(managed.page)) {
    const githubSelected = await ensureGitHubSelectedV2(managed.page, "GitHub").catch(() => false);
    if (!githubSelected) {
      const current = self.agents?.get(agent.id);
      if (current) Object.assign(current, {
        status: "failed",
        lastError: "GitHub App could not be selected during agent initialization",
        updatedAt: Date.now(),
      });
    }
  }

  const emit = self.onEvent ?? (() => undefined);
  const patch = (changes: Record<string, unknown>) => {
    const current = self.agents?.get(agent.id);
    if (current) Object.assign(current, changes, { updatedAt: Date.now() });
  };
  await startChatGPTPageSync(
    managed as never,
    managed.page,
    emit as never,
    patch as never,
  ).catch(() => undefined);
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
  await page.waitForFunction((expected) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']"));
    return nodes.some((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
      if (node.classList.contains("wcDTda_fallbackTextarea")) return false;
      const value = node instanceof HTMLTextAreaElement ? node.value : node.innerText || node.textContent || "";
      return value.trim() === String(expected).trim();
    });
  }, text, { timeout: 5000 });
  for (const selector of ["button[data-testid='send-button']", "button[aria-label*='Send' i]", "button[aria-label*='发送' i]", "button[type='submit']"]) {
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
