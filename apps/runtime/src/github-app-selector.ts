import type { Page } from "playwright";

type ComposerLike = ReturnType<Page["locator"]>;

const selectionPromises = new WeakMap<Page, Promise<boolean>>();
const selectionResults = new WeakMap<Page, boolean>();

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

async function waitForComposer(page: Page, timeoutMs = 15000): Promise<ComposerLike | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChatGPTUrl(page)) return undefined;
    const composer = await findComposer(page);
    if (composer) return composer;
    await page.waitForTimeout(250);
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
      "[data-testid*='mention' i], [data-testid*='app' i], [aria-label*='GitHub' i], [role='option']",
    ));
    const re = new RegExp(`(^|\\s|@)${pattern}(\\s|$)`, "i");
    return nodes.some((node) => {
      if (!visible(node)) return false;
      const text = `${node.getAttribute("aria-label") ?? ""} ${node.textContent ?? ""} ${node.getAttribute("data-testid") ?? ""}`;
      return re.test(text) && !node.closest("a[href]");
    });
  }, escaped).catch(() => false);
}

async function hasVisibleGitHubOption(page: Page, appName: string): Promise<boolean> {
  const candidates = page.getByText(appName, { exact: true });
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const navigation = await candidate.evaluate((node) => Boolean(node.closest("a[href]"))).catch(() => true);
    if (!navigation) return true;
  }
  return false;
}

async function cleanComposer(composer: ComposerLike | undefined): Promise<void> {
  if (!composer) return;
  await composer.press("Control+A").catch(() => undefined);
  await composer.press("Backspace").catch(() => undefined);
}

async function selectGitHubInternal(page: Page, appName: string): Promise<boolean> {
  if (!isChatGPTUrl(page)) return false;
  const composer = await waitForComposer(page);
  if (!composer) return false;

  const beforeUrl = page.url();
  await composer.click({ timeout: 5000 });

  if (await hasAppMention(page, appName)) return true;

  await composer.pressSequentially(`@${appName}`, { delay: 35 });
  await page.waitForTimeout(400);
  if (!isChatGPTUrl(page)) return false;
  if (await hasAppMention(page, appName)) return true;

  // Space is the primary ChatGPT mention-selection gesture. Treat the action
  // as committed when ChatGPT remains on the conversation and the suggestion
  // option disappears; DOM implementations do not always expose a stable
  // mention test id, but they do consistently remove the active option.
  await composer.press("Space").catch(() => undefined);
  await page.waitForTimeout(600);
  if (!isChatGPTUrl(page)) return false;
  if (await hasAppMention(page, appName)) return true;
  if (!await hasVisibleGitHubOption(page, appName)) return true;

  // Last-resort click: only a visible non-navigation option is eligible.
  const candidates = page.getByText(appName, { exact: true });
  for (let index = (await candidates.count()) - 1; index >= 0; index -= 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const isNavigation = await candidate.evaluate((node) => {
      if (node.closest("a[href]")) return true;
      if (node.hasAttribute("href")) return true;
      return Boolean(node.closest("[href]"));
    }).catch(() => true);
    if (isNavigation) continue;
    await candidate.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    if (isChatGPTUrl(page) && (await hasAppMention(page, appName) || !await hasVisibleGitHubOption(page, appName))) return true;
  }

  if (page.url() !== beforeUrl && !isChatGPTUrl(page)) {
    await page.goto(beforeUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => undefined);
  }
  if (isChatGPTUrl(page)) await cleanComposer(await findComposer(page));
  return false;
}

export function ensureGitHubSelected(page: Page, appName = "GitHub"): Promise<boolean> {
  const previousResult = selectionResults.get(page);
  if (previousResult !== undefined) return Promise.resolve(previousResult);
  const existing = selectionPromises.get(page);
  if (existing) return existing;

  const promise = selectGitHubInternal(page, appName)
    .then((result) => {
      selectionResults.set(page, result);
      return result;
    })
    .catch(() => {
      selectionResults.set(page, false);
      return false;
    })
    .finally(() => selectionPromises.delete(page));

  selectionPromises.set(page, promise);
  return promise;
}
