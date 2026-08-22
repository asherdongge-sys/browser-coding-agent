import type { Page } from "playwright";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";

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
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url);
}

async function hasGitHubMention(page: Page, appName: string): Promise<boolean> {
  return page.evaluate((name) => {
    const visible = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
    };
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-testid*='mention' i], [data-testid*='app' i], [aria-label*='GitHub' i], [contenteditable='true'] [contenteditable='false'], [contenteditable='true']",
    ));
    return candidates.some((node) => {
      if (!visible(node)) return false;
      const text = `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""} ${node.getAttribute("data-testid") ?? ""}`;
      return new RegExp(`(^|\\s|@)${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&")}(\\s|$)`, "i").test(text);
    });
  }, appName).catch(() => false);
}

async function clearComposer(composer: Awaited<ReturnType<typeof findComposer>>) {
  if (!composer) return;
  await composer.press("Control+A").catch(() => undefined);
  await composer.press("Backspace").catch(() => undefined);
}

provider.selectChatGPTApp = async function selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
  const composer = await findComposer(page);
  if (!composer) return false;
  if (!await isChatGPTPage(page)) return false;

  const beforeUrl = page.url();
  await composer.click({ timeout: 5000 });

  // The ChatGPT composer reliably commits an app mention when the user types
  // "@App" and presses Space. Prefer that path over clicking arbitrary text,
  // because clicking a result that is actually an <a> can navigate away.
  await composer.pressSequentially(`@${appName}`, { delay: 35 });
  await page.waitForTimeout(250);
  await composer.press("Space").catch(() => undefined);
  await page.waitForTimeout(250);

  if (await isChatGPTPage(page) && await hasGitHubMention(page, appName)) return true;

  // If the menu is still open, only click a non-navigation menu item. Never
  // click an anchor because it may open the app/plugin page instead of selecting it.
  const candidates = page.getByText(appName, { exact: true });
  for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const navigation = await candidate.evaluate((node) => {
      const anchor = node.closest("a");
      if (anchor) return true;
      const href = node.getAttribute("href");
      return Boolean(href);
    }).catch(() => true);
    if (navigation) continue;
    await candidate.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(250);
    if (await isChatGPTPage(page) && await hasGitHubMention(page, appName)) return true;
  }

  // Never treat a disappearing menu as success. If selection failed, restore
  // the composer to a clean state and let the caller fail before sending.
  if (page.url() !== beforeUrl && await isChatGPTPage(page) === false) {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => undefined);
  }
  await clearComposer(composer);
  return false;
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
