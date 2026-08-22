import type { Page } from "playwright";

type ComposerLike = ReturnType<Page["locator"]>;

const selectionPromises = new WeakMap<Page, Promise<boolean>>();

function isChatGPTUrl(page: Page): boolean {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(page.url());
}

async function findComposer(page: Page): Promise<ComposerLike | undefined> {
  const selectors = [
    "[contenteditable='true']:not([aria-hidden='true'])",
    "textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)",
    "textarea:not(.wcDTda_fallbackTextarea)",
    "[role='textbox']:not([aria-hidden='true'])",
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector);
    for (let index = (await locator.count()) - 1; index >= 0; index -= 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}

async function hasAppMention(page: Page, appName: string): Promise<boolean> {
  const escaped = escapeRegExp(appName);
  return page.evaluate((pattern) => {
    const visible = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
    };
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(
      "[data-testid*='mention' i], [data-testid*='app' i], [aria-label*='GitHub' i]",
    ));
    const re = new RegExp(`(^|\\s|@)${pattern}(\\s|$)`, "i");
    return nodes.some((node) => {
      if (!visible(node)) return false;
      const text = `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""} ${node.getAttribute("data-testid") ?? ""}`;
      return re.test(text);
    });
  }, escaped).catch(() => false);
}

async function cleanComposer(composer: ComposerLike | undefined): Promise<void> {
  if (!composer) return;
  await composer.press("Control+A").catch(() => undefined);
  await composer.press("Backspace").catch(() => undefined);
}

async function selectGitHubInternal(page: Page, appName: string): Promise<boolean> {
  if (!isChatGPTUrl(page)) return false;

  const composer = await findComposer(page);
  if (!composer) return false;

  const beforeUrl = page.url();
  await composer.click({ timeout: 5000 });

  // Do not inject a second mention if the app is already selected.
  if (await hasAppMention(page, appName)) return true;

  // ChatGPT's reliable selection path is: type @App, then Space.
  await composer.pressSequentially(`@${appName}`, { delay: 35 });
  await page.waitForTimeout(300);

  if (!isChatGPTUrl(page)) return false;
  if (await hasAppMention(page, appName)) return true;

  await composer.press("Space").catch(() => undefined);
  await page.waitForTimeout(350);

  if (isChatGPTUrl(page) && await hasAppMention(page, appName)) return true;

  // Fallback only while the suggestion menu is open. Never click navigation
  // anchors or anything carrying an href: those can open the app detail page.
  const candidates = page.getByText(appName, { exact: true });
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;

    const isNavigation = await candidate.evaluate((node) => {
      if (node.closest("a")) return true;
      if (node.hasAttribute("href")) return true;
      const parent = node.closest("[href]");
      return Boolean(parent);
    }).catch(() => true);
    if (isNavigation) continue;

    await candidate.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(350);

    if (!isChatGPTUrl(page)) break;
    if (await hasAppMention(page, appName)) return true;
  }

  // Never consider a disappearing menu to be success. If an accidental click
  // navigated away, restore the conversation before failing initialization.
  if (page.url() !== beforeUrl && !isChatGPTUrl(page)) {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => undefined);
  }

  if (isChatGPTUrl(page)) {
    const currentComposer = await findComposer(page);
    await cleanComposer(currentComposer);
  }
  return false;
}

export function ensureGitHubSelected(page: Page, appName = "GitHub"): Promise<boolean> {
  const existing = selectionPromises.get(page);
  if (existing) return existing;

  const promise = selectGitHubInternal(page, appName).finally(() => {
    selectionPromises.delete(page);
  });
  selectionPromises.set(page, promise);
  return promise;
}
