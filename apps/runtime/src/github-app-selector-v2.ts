import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;
type ClipboardSnapshot = { html: string; text: string };

const running = new WeakMap<Page, Promise<boolean>>();
const composers = new WeakMap<Page, Composer>();
const selectionLeases = new WeakMap<Page, number>();
const clipboardSnapshots = new WeakMap<Page, ClipboardSnapshot>();

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

/** Read the user's existing clipboard without overwriting rich clipboard data. */
async function readClipboard(page: Page): Promise<ClipboardSnapshot | undefined> {
  try {
    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => undefined);
    return await page.evaluate(async () => {
      if (!navigator.clipboard?.read) return undefined;
      const items = await navigator.clipboard.read();
      let html = "";
      let text = "";
      for (const item of items) {
        if (item.types.includes("text/html")) {
          html = await (await item.getType("text/html")).text();
        }
        if (item.types.includes("text/plain")) {
          text = await (await item.getType("text/plain")).text();
        }
      }
      return { html, text };
    });
  } catch {
    return undefined;
  }
}

/**
 * Paste the existing OS clipboard as-is. Do NOT call clipboard.writeText here:
 * that destroys the rich text / HTML representation that ChatGPT uses to turn
 * a copied @GitHub connector token into a real connector mention.
 */
async function pasteExistingClipboard(page: Page, composer: Composer): Promise<ClipboardSnapshot | undefined> {
  const snapshot = await readClipboard(page);
  if (!snapshot) return undefined;
  if (!/github/i.test(`${snapshot.text}\n${snapshot.html}`)) return undefined;
  await composer.click({ timeout: 5000 });
  await composer.press("Control+V");
  return snapshot;
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
 * The important distinction is that we preserve the user's rich clipboard;
 * writing plain "@GitHub" into the clipboard was the reason the previous
 * implementation only inserted literal @GitHub text.
 */
async function choose(page: Page): Promise<boolean> {
  const composer = await waitForComposer(page);
  if (!composer) return false;
  if (await isGitHubSelected(page)) {
    composers.set(page, composer);
    return true;
  }

  await clearComposer(composer);
  const snapshot = await pasteExistingClipboard(page, composer);
  if (!snapshot) {
    console.warn("[BrowserCodingAgent] GitHub connector requires the rich @GitHub clipboard token; plain-text @GitHub paste is intentionally disabled");
    return false;
  }
  clipboardSnapshots.set(page, snapshot);
  if (await waitForParsedGitHub(page, composer)) return true;

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

  // Do NOT clear and re-paste "@GitHub". That destroys the connector token.
  // The token is already present in the composer from the rich clipboard paste.
  // Append the actual prompt as plain text so the final message remains one
  // composer submission containing the already-selected GitHub connector.
  await composer.click({ timeout: 5000 });
  await composer.press("End").catch(() => undefined);
  await composer.pressSequentially(` ${text}`, { delay: 2 });

  if (!await isGitHubSelected(page)) {
    throw new Error("GitHub connector was lost while composing the message");
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
