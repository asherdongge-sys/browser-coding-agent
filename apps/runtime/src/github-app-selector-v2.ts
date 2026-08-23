import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;
const locks = new WeakMap<Page, Promise<boolean>>();

function onChatGPT(page: Page): boolean {
  const url = page.url();
  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)(\/|$)/.test(url)) return false;
  const path = new URL(url).pathname;
  return !/^\/(apps|gpts)(?:\/|$)/i.test(path);
}

async function composer(page: Page): Promise<Composer | undefined> {
  for (const selector of [
    "[contenteditable='true']:not([aria-hidden='true'])",
    "textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)",
    "textarea:not(.wcDTda_fallbackTextarea)",
    "[role='textbox']:not([aria-hidden='true'])",
  ]) {
    const nodes = page.locator(selector);
    for (let i = await nodes.count() - 1; i >= 0; i -= 1) {
      const node = nodes.nth(i);
      if (await node.isVisible().catch(() => false)) return node;
    }
  }
  return undefined;
}

async function committed(c: Composer, name: string): Promise<boolean> {
  return c.evaluate((node, app) => {
    const text = `${(node as HTMLTextAreaElement).value ?? ""} ${(node as HTMLElement).innerText ?? ""} ${(node as HTMLElement).textContent ?? ""}`;
    const chip = Array.from(node.querySelectorAll<HTMLElement>("[data-mention], [data-testid*='mention' i], [aria-label*='GitHub' i]"))
      .some((n) => `${n.getAttribute("aria-label") ?? ""} ${n.textContent ?? ""}`.toLowerCase().includes(String(app).toLowerCase()));
    const escaped = String(app).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return chip || new RegExp(`(^|\\s)@${escaped}(?:\\s|$)`, "i").test(text);
  }, name).catch(() => false);
}

async function visibleOption(page: Page, name: string): Promise<boolean> {
  const items = page.getByText(name, { exact: true });
  for (let i = await items.count() - 1; i >= 0; i -= 1) {
    const item = items.nth(i);
    if (!await item.isVisible().catch(() => false)) continue;
    const safe = await item.evaluate((n) => !n.closest("a[href], [href]") && !n.hasAttribute("href")).catch(() => false);
    if (safe) return true;
  }
  return false;
}

async function selectOnce(page: Page, name: string): Promise<boolean> {
  if (!onChatGPT(page)) return false;
  const c = await composer(page);
  if (!c) return false;
  const originalUrl = page.url();

  await c.click({ timeout: 5000 });
  if (await committed(c, name)) return true;

  // Do not use pressSequentially here. It can wait up to 30s for Playwright's
  // keyboard path when ChatGPT swaps/replaces the composer during an update.
  // fill() updates the same input without depending on per-character keyboard
  // events and is much more reliable for the short @GitHub trigger.
  await c.fill(`@${name}`, { timeout: 5000 });
  await page.waitForTimeout(500);
  if (!onChatGPT(page)) return false;

  // ChatGPT may expose the App as an autocomplete item rather than committing
  // the mention immediately. Prefer the visible item when available.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await committed(c, name)) return true;

    if (await visibleOption(page, name)) {
      const items = page.getByText(name, { exact: true });
      for (let i = await items.count() - 1; i >= 0; i -= 1) {
        const item = items.nth(i);
        if (!await item.isVisible().catch(() => false)) continue;
        const safe = await item.evaluate((n) => !n.closest("a[href], [href]") && !n.hasAttribute("href")).catch(() => false);
        if (!safe) continue;
        await item.click({ timeout: 3000 }).catch(() => undefined);
        await page.waitForTimeout(400);
        if (await committed(c, name)) return true;
      }
    }

    await page.waitForTimeout(300);
  }

  // Some ChatGPT builds commit the autocomplete with Space instead of a click.
  await c.press("Space", { timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  if (await committed(c, name)) return true;

  // If ChatGPT navigated while resolving the App, restore the original chat.
  if (!onChatGPT(page)) {
    await page.goto(originalUrl, { waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => undefined);
  }
  return false;
}

export function ensureGitHubSelectedV2(page: Page, name = "GitHub"): Promise<boolean> {
  const current = locks.get(page);
  if (current) return current;
  const operation = selectOnce(page, name);
  locks.set(page, operation);
  void operation.finally(() => {
    if (locks.get(page) === operation) locks.delete(page);
  });
  return operation;
}
