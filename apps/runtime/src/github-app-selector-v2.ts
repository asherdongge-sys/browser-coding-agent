import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;

const running = new WeakMap<Page, Promise<boolean>>();
const composers = new WeakMap<Page, Composer>();
const selectionLeases = new WeakMap<Page, number>();

const chat = (page: Page): boolean => {
  try {
    const url = new URL(page.url());
    return url.protocol === "https:" &&
      (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
      !/^\/(apps|gpts)(?:\/|$)/i.test(url.pathname);
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

function isConnectorMenuItemText(text: string): boolean {
  return /GitHub/i.test(text) && !/(plugin|plugins|details|directory|管理|详情)/i.test(text);
}

async function findOpenMenu(page: Page): Promise<Composer | undefined> {
  const candidates = [
    page.locator("[role='menu']:visible"),
    page.locator("[role='listbox']:visible"),
    page.locator("[data-radix-menu-content]:visible"),
    page.locator("[data-radix-popper-content-wrapper]:visible"),
  ];

  for (const menus of candidates) {
    for (let index = await menus.count() - 1; index >= 0; index -= 1) {
      const menu = menus.nth(index);
      if (await visible(menu)) return menu;
    }
  }
  return undefined;
}

async function clickGitHubMenuItem(page: Page, menu: Composer): Promise<boolean> {
  const items = menu.locator("[role='menuitem'], [role='option'], button, a");
  const count = await items.count();

  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    if (!await visible(item)) continue;

    const text = [
      await item.innerText().catch(() => ""),
      await item.getAttribute("aria-label").catch(() => null) ?? "",
      await item.getAttribute("title").catch(() => null) ?? "",
    ].join(" ");

    if (!isConnectorMenuItemText(text)) continue;

    const beforeUrl = page.url();
    await item.click({ timeout: 2500 });

    await page.waitForTimeout(300);

    // Selecting a connector must never navigate into the app/plugin directory.
    if (!chat(page) || page.url() !== beforeUrl) return false;
    if (await isGitHubSelected(page)) return true;
  }

  return false;
}

async function openConnectorMenu(page: Page, composer: Composer): Promise<boolean> {
  // Only inspect controls associated with the composer. Never scan arbitrary
  // "GitHub" text or app/plugin links across the whole document.
  const root = composer.locator("xpath=ancestor-or-self::*[self::form or @data-testid or @role='group'][1]");
  const scope = await root.count() > 0 ? root : page.locator("body");

  const buttons = scope.locator("button");
  const count = await buttons.count();

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!await visible(button)) continue;

    const aria = await button.getAttribute("aria-label").catch(() => null);
    const title = await button.getAttribute("title").catch(() => null);
    const testId = await button.getAttribute("data-testid").catch(() => null);
    const text = await button.innerText().catch(() => "");
    const label = `${aria ?? ""} ${title ?? ""} ${testId ?? ""} ${text}`;

    if (!/(^|\b)(app|apps|connector|tool|more|add|attach|应用|连接器|工具|更多)(\b|$)/i.test(label)) continue;

    const beforeUrl = page.url();
    await button.click({ timeout: 2500 }).catch(() => undefined);
    await page.waitForTimeout(250);

    if (!chat(page) || page.url() !== beforeUrl) return false;

    const menu = await findOpenMenu(page);
    if (!menu) continue;

    if (await clickGitHubMenuItem(page, menu)) return true;

    // This was a real menu, but it was not the connector menu. Close it once
    // and continue; do not retry the click repeatedly.
    await page.keyboard.press("Escape").catch(() => undefined);
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
  if (await openConnectorMenu(page, composer)) {
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
