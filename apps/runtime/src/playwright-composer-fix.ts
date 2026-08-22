import type { Page } from "playwright";
import { PlaywrightBrowserProvider } from "./playwright-browser-provider.js";

type ProviderPrototype = {
  submitComposer(page: Page, text: string): Promise<void>;
};

const provider = PlaywrightBrowserProvider.prototype as unknown as ProviderPrototype;

provider.submitComposer = async function submitComposer(page: Page, text: string): Promise<void> {
  const candidates = [
    "[contenteditable='true']:not([aria-hidden='true'])",
    "textarea:not(.wcDTda_fallbackTextarea)",
    "textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)",
    "[role='textbox']:not([aria-hidden='true'])",
  ];

  let composer = undefined as ReturnType<Page["locator"]> | undefined;
  for (const selector of candidates) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        composer = candidate;
        break;
      }
    }
    if (composer) break;
  }

  if (!composer) {
    throw new Error("ChatGPT composer is not visible");
  }

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
    const count = await buttons.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      if (await button.isDisabled().catch(() => true)) continue;
      await button.click({ timeout: 5000 });
      return;
    }
  }

  await composer.press("Enter");
};
