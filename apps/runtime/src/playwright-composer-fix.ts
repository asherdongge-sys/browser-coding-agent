import type { Page } from "playwright";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";
import { ensureGitHubSelected } from "./github-app-selector.js";

type ProviderPrototype = {
  submitComposer(page: Page, text: string): Promise<void>;
  selectChatGPTApp(page: Page, appName: string): Promise<boolean>;
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
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(url);
}

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return false;
  if (!await isChatGPTPage(page)) return false;
  return ensureGitHubSelected(page, appName);
};

provider.submitComposer = async function submitComposer(page: Page, text: string): Promise<void> {
  const composer = await findComposer(page);
  if (!composer) throw new Error("ChatGPT composer is not visible");
  if (!await isChatGPTPage(page)) throw new Error("ChatGPT page navigated away from the conversation");

  await composer.click({ timeout: 5000 });
  await composer.fill(text);
  await page.waitForFunction((expected) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(
      "[contenteditable='true'], textarea, [role='textbox']",
    ));
    return nodes.some((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || rect.width === 0 || rect.height === 0) return false;
      if (node.classList.contains("wcDTda_fallbackTextarea")) return false;
      const value = node instanceof HTMLTextAreaElement ? node.value : node.innerText || node.textContent || "";
      return value.trim() === String(expected).trim();
    });
  }, text, { timeout: 5000 });

  const sendSelectors = [
    "button[data-testid='send-button']",
    "button[aria-label*='Send' i]",
    "button[aria-label*='发送' i]",
    "button[type='submit']",
  ];
  for (const selector of sendSelectors) {
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
