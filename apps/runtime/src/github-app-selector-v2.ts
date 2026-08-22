import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;

const inFlight = new WeakMap<Page, Promise<boolean>>();
const results = new WeakMap<Page, boolean>();
const selectedComposers = new WeakMap<Page, Composer>();

function isConversationPage(page: Page): boolean {
  try {
    const url = new URL(page.url());
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return false;
    return !/^\/(apps|gpts)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

async function findComposer(page: Page): Promise<Composer | undefined> {
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

async function waitForComposer(page: Page, timeoutMs = 30000): Promise<Composer | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isConversationPage(page)) return undefined;
    const composer = await findComposer(page);
    if (composer) return composer;
    await page.waitForTimeout(300);
  }
  return undefined;
}

async function hasVisibleGitHubMenu(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
    };
    return Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], [role='listbox']"))
      .some((node) => visible(node) && /github/i.test(node.innerText || node.textContent || ""));
  }).catch(() => false);
}

async function hasCommittedGitHubMention(page: Page): Promise<boolean> {
  if (!isConversationPage(page)) return false;
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1;
    };
    const composerNodes = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']"));
    const composer = composerNodes.reverse().find(visible);
    if (!composer) return false;
    const explicit = Array.from(composer.querySelectorAll<HTMLElement>(
      "[data-mention], [data-testid*='mention' i], [aria-label*='GitHub' i]",
    )).some(visible);
    if (explicit) return true;
    const text = `${composer.textContent ?? ""} ${(composer as HTMLTextAreaElement).value ?? ""}`.trim();
    return /(^|\s)GitHub(?:\s|$)/i.test(text) && !/@GitHub/i.test(text) && !Array.from(
      document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], [role='listbox']"),
    ).some(visible);
  }).catch(() => false);
}

async function composerText(page: Page): Promise<string> {
  const composer = await findComposer(page);
  if (!composer) return "";
  return composer.evaluate((node) => `${node.textContent ?? ""} ${(node as HTMLTextAreaElement).value ?? ""}`).catch(() => "");
}

async function clearComposer(page: Page, composer: Composer): Promise<void> {
  await composer.click({ timeout: 5000 }).catch(() => undefined);
  await composer.press("Control+A").catch(() => undefined);
  await composer.press("Backspace").catch(() => undefined);
  await page.waitForTimeout(100);
}

async function selectGitHubInternal(page: Page): Promise<boolean> {
  const composer = await waitForComposer(page);
  if (!composer) return false;

  if (await hasCommittedGitHubMention(page)) {
    selectedComposers.set(page, composer);
    return true;
  }

  const existingText = await composerText(page);
  if (/@GitHub/i.test(existingText)) await clearComposer(page, composer);

  // IMPORTANT: selection and subsequent message entry must use the same
  // composer without clicking/refinding it again. ChatGPT can transiently
  // render an app chip and then lose that chip when the editor is refocused.
  await composer.click({ timeout: 5000 });
  await composer.pressSequentially("@GitHub", { delay: 35 });
  await page.waitForTimeout(350);
  if (!isConversationPage(page)) return false;

  // ChatGPT's current UI commits the first app suggestion with Space.
  // Never click a GitHub text node: those nodes can navigate to /apps/*.
  await composer.press("Space").catch(() => undefined);
  await page.waitForTimeout(700);
  if (!isConversationPage(page)) return false;

  if (await hasCommittedGitHubMention(page)) {
    selectedComposers.set(page, composer);
    return true;
  }

  const textAfterCommit = await composerText(page);
  const accepted = !await hasVisibleGitHubMenu(page) && /GitHub/i.test(textAfterCommit) && !/@GitHub/i.test(textAfterCommit);
  if (accepted) selectedComposers.set(page, composer);
  return accepted;
}

export function ensureGitHubSelectedV2(page: Page, _appName = "GitHub"): Promise<boolean> {
  const cached = results.get(page);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = inFlight.get(page);
  if (running) return running;
  const promise = selectGitHubInternal(page)
    .then((selected) => { results.set(page, selected); return selected; })
    .catch(() => { results.set(page, false); return false; })
    .finally(() => inFlight.delete(page));
  inFlight.set(page, promise);
  return promise;
}

/**
 * Type the user message into the SAME composer that committed the GitHub
 * mention. Do not refocus/click/find another composer between these steps.
 */
export async function submitMessageAfterGitHubSelection(page: Page, text: string): Promise<void> {
  const composer = selectedComposers.get(page) ?? await findComposer(page);
  if (!composer) throw new Error("ChatGPT composer is not available after selecting GitHub");

  // Deliberately do not click/focus here. The selection gesture may have
  // created a special inline app token whose state is lost on editor refocus.
  await page.keyboard.type(text, { delay: 5 });

  for (const selector of [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="发送" i]',
    'button[type="submit"]',
  ]) {
    const buttons = page.locator(selector);
    for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
      const button = buttons.nth(index);
      if (!await button.isVisible().catch(() => false)) continue;
      if (await button.isDisabled().catch(() => true)) continue;
      await button.click({ timeout: 5000 });
      return;
    }
  }
  await page.keyboard.press("Enter");
}
