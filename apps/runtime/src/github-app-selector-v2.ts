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

async function clearComposer(composer: Composer): Promise<void> {
  await composer.click({ timeout: 5000 });
  await composer.press("Control+A").catch(() => undefined);
  await composer.press("Backspace").catch(() => undefined);
}

/**
 * ChatGPT's current composer recognizes pasted @GitHub text as a connector mention,
 * while synthetic keyboard typing is treated as ordinary text. Use a real clipboard
 * paste event so ChatGPT owns the parsing/tokenization of the connector.
 */
async function pasteText(page: Page, composer: Composer, text: string): Promise<boolean> {
  try {
    await composer.click({ timeout: 5000 });
    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => undefined);
    await page.evaluate(async (value) => {
      await navigator.clipboard.writeText(value);
    }, text);
    await composer.press("Control+V");
    return true;
  } catch {
    return false;
  }
}

async function waitForParsedGitHub(page: Page, composer: Composer, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!chat(page)) return false;
    if (await isGitHubSelected(page)) {
      composers.set(page, composer);
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

/**
 * Single-shot GitHub connector preparation.
 * Never opens the connector menu and never types @GitHub character-by-character.
 */
async function choose(page: Page): Promise<boolean> {
  const composer = await waitForComposer(page);
  if (!composer) return false;
  if (await isGitHubSelected(page)) {
    composers.set(page, composer);
    return true;
  }

  // This is intentionally a real paste. The user has verified that ChatGPT's
  // paste parser converts the @GitHub marker into the connector token.
  await clearComposer(composer);
  if (!await pasteText(page, composer, "@GitHub ")) return false;
  if (await waitForParsedGitHub(page, composer)) return true;

  // Do not retry with keyboard input or connector-menu clicks: those paths were
  // producing duplicate GitHub mentions and navigation to the app detail page.
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

  // The most reliable path is another single real paste containing the connector
  // marker and the actual prompt. ChatGPT parses this as one user message rather
  // than receiving a separate @GitHub keyboard turn followed by the prompt.
  await clearComposer(composer);
  if (!await pasteText(page, composer, `@GitHub ${text}`)) {
    throw new Error("Unable to paste GitHub connector message into the ChatGPT composer");
  }
  if (!await waitForParsedGitHub(page, composer, 5000)) {
    throw new Error("ChatGPT did not parse @GitHub as a connector in the composer");
  }

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
