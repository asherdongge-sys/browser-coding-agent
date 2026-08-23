import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;

const running = new WeakMap<Page, Promise<boolean>>();
const composers = new WeakMap<Page, Composer>();
const selectionLeases = new WeakMap<Page, number>();

const chat = (page: Page): boolean => {
  try {
    const url = new URL(page.url());
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && !/^\/(apps|gpts)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
};

const visible = async (locator: Composer): Promise<boolean> => locator.isVisible().catch(() => false);

async function findComposer(page: Page): Promise<Composer | undefined> {
  for (const selector of [
    "[contenteditable='true']:not([aria-hidden='true'])",
    "textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)",
    "textarea:not(.wcDTda_fallbackTextarea)",
    "[role='textbox']:not([aria-hidden='true'])",
  ]) {
    const nodes = page.locator(selector);
    for (let index = await nodes.count() - 1; index >= 0; index -= 1) {
      const candidate = nodes.nth(index);
      if (await visible(candidate)) return candidate;
    }
  }
  return undefined;
}

async function waitForComposer(page: Page): Promise<Composer | undefined> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (!chat(page)) return undefined;
    const composer = await findComposer(page);
    if (composer) return composer;
    await page.waitForTimeout(500);
  }
  return undefined;
}

async function isGitHubSelected(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const isVisible = (node: HTMLElement) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
      };
      const composer = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']"))
        .reverse()
        .find(isVisible);
      if (!composer) return false;
      const selected = Array.from(composer.querySelectorAll<HTMLElement>(
        "[data-mention], [data-testid*='mention' i], [aria-label*='GitHub' i], [data-app-id*='github' i], [data-connector*='github' i]",
      )).some(isVisible);
      if (selected) return true;
      const text = `${composer.textContent ?? ""} ${(composer as HTMLTextAreaElement).value ?? ""}`;
      return /GitHub/i.test(text) && !/@GitHub/i.test(text);
    });
  } catch {
    return false;
  }
}

async function clickGitHubMenuItem(page: Page): Promise<boolean> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (const selector of ["[role='option']", "[role='menuitem']", "[data-testid*='app' i]", "[data-testid*='connector' i]"]) {
      const items = page.locator(selector);
      for (let index = await items.count() - 1; index >= 0; index -= 1) {
        const item = items.nth(index);
        if (!await visible(item)) continue;
        const text = await item.innerText().catch(() => "");
        const label = await item.getAttribute("aria-label").catch(() => null);
        if (!/GitHub/i.test(`${text} ${label ?? ""}`)) continue;
        await item.click({ timeout: 1500 }).catch(() => undefined);
        if (await isGitHubSelected(page)) return true;
      }
    }

    const exact = page.getByText("GitHub", { exact: true });
    for (let index = await exact.count() - 1; index >= 0; index -= 1) {
      const item = exact.nth(index);
      if (!await visible(item)) continue;
      await item.click({ timeout: 1500 }).catch(() => undefined);
      if (await isGitHubSelected(page)) return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function openConnectorMenu(page: Page): Promise<boolean> {
  const selectors = [
    'button[aria-label*="app" i]',
    'button[aria-label*="connector" i]',
    'button[aria-label*="tool" i]',
    'button[aria-label*="add" i]',
    'button[data-testid*="app" i]',
    'button[data-testid*="connector" i]',
    'button[data-testid*="composer" i]',
  ];

  for (const selector of selectors) {
    const buttons = page.locator(selector);
    for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!await visible(button)) continue;
      const aria = await button.getAttribute("aria-label").catch(() => null);
      const title = await button.getAttribute("title").catch(() => null);
      const text = await button.innerText().catch(() => "");
      if (!/(app|connector|tool|add|添加|应用|连接器|工具)/i.test(`${aria ?? ""} ${title ?? ""} ${text}`)) continue;
      await button.click({ timeout: 2500 }).catch(() => undefined);
      if (await clickGitHubMenuItem(page)) return true;
    }
  }
  return false;
}

async function choose(page: Page): Promise<boolean> {
  const composer = await waitForComposer(page);
  if (!composer) return false;
  if (await isGitHubSelected(page)) {
    composers.set(page, composer);
    return true;
  }

  await composer.click({ timeout: 5000 }).catch(() => undefined);
  if (await openConnectorMenu(page)) {
    composers.set(page, composer);
    return true;
  }
  return false;
}

export function primeGitHubSelectionLease(page: Page): void {
  selectionLeases.set(page, (selectionLeases.get(page) ?? 0) + 1);
}

export function ensureGitHubSelectedV2(page: Page, appName = "GitHub"): Promise<boolean> {
  if (appName.toLowerCase() !== "github") return Promise.resolve(false);
  const lease = selectionLeases.get(page) ?? 0;
  if (lease > 0) {
    selectionLeases.set(page, lease - 1);
    return Promise.resolve(true);
  }
  const existing = running.get(page);
  if (existing) return existing;
  const promise = choose(page)
    .then((selected) => {
      if (selected) selectionLeases.set(page, (selectionLeases.get(page) ?? 0) + 1);
      return selected;
    })
    .catch(() => false)
    .finally(() => running.delete(page));
  running.set(page, promise);
  return promise;
}

export async function submitMessageAfterGitHubSelection(page: Page, text: string): Promise<void> {
  const composer = composers.get(page) ?? await findComposer(page);
  if (!composer) throw new Error("ChatGPT composer is not available after selecting GitHub");
  if (!await isGitHubSelected(page)) throw new Error("GitHub connector is no longer selected in the ChatGPT composer");

  await composer.click({ timeout: 5000 });
  await composer.evaluate((node, value) => {
    (node as HTMLElement).focus();
    document.execCommand("insertText", false, value);
    node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }, text).catch(() => composer.pressSequentially(text, { delay: 5 }));

  for (const selector of [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送" i]',
    'button[type="submit"]',
  ]) {
    const buttons = page.locator(selector);
    for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!await visible(button)) continue;
      if (await button.isDisabled().catch(() => true)) continue;
      await button.click({ timeout: 5000 });
      return;
    }
  }
  await composer.press("Enter");
}
