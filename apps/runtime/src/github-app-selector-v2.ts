import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;

const inFlight = new WeakMap<Page, Promise<boolean>>();
const results = new WeakMap<Page, boolean>();

function isConversationPage(page: Page): boolean {
  try {
    const url = new URL(page.url());
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return false;
    return !/^\/(apps|gpts)(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}

async function findComposer(page: Page): Promise<Composer | undefined> {
  for (const selector of ["[contenteditable='true']:not([aria-hidden='true'])","textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)","textarea:not(.wcDTda_fallbackTextarea)","[role='textbox']:not([aria-hidden='true'])"]) {
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
    await page.waitForTimeout(250);
  }
  return undefined;
}

async function hasVisibleGitHubMenu(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1; };
    return Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], [role='listbox']"))
      .some((node) => visible(node) && /github/i.test(node.innerText || node.textContent || ""));
  }).catch(() => false);
}

async function hasCommittedGitHubMention(page: Page): Promise<boolean> {
  if (!isConversationPage(page)) return false;
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1; };
    const composerNodes = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']"));
    const composer = composerNodes.reverse().find(visible);
    if (!composer) return false;
    const explicit = Array.from(composer.querySelectorAll<HTMLElement>("[data-mention], [data-testid*='mention' i], [aria-label*='GitHub' i]")).some(visible);
    if (explicit) return true;
    const text = `${composer.textContent ?? ""} ${(composer as HTMLTextAreaElement).value ?? ""}`.trim();
    // After Space ChatGPT commonly converts @GitHub into an inline app token
    // whose visible text is GitHub rather than @GitHub. Require the composer
    // itself to contain GitHub and make sure the suggestion menu is gone.
    return /(^|\s)GitHub(?:\s|$)/i.test(text) && !/@GitHub/i.test(text) && !Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], [role='listbox']")).some(visible);
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

  // Idempotency is enforced at the DOM level as well as by the Promise cache.
  // This is important because several callers can reach initialization during
  // Agent creation. Never append another @GitHub to an existing composer.
  if (await hasCommittedGitHubMention(page)) return true;

  const existingText = await composerText(page);
  if (/@GitHub/i.test(existingText)) await clearComposer(page, composer);

  await composer.click({ timeout: 5000 });
  await composer.pressSequentially("@GitHub", { delay: 35 });
  await page.waitForTimeout(350);
  if (!isConversationPage(page)) return false;

  // The current ChatGPT UI commits the first app suggestion with Space. Do
  // exactly one commit gesture and never click a GitHub text node: such nodes
  // can be links to the app detail page.
  await composer.press("Space").catch(() => undefined);
  await page.waitForTimeout(700);
  if (!isConversationPage(page)) return false;

  if (await hasCommittedGitHubMention(page)) return true;

  // If ChatGPT did not expose a token but the suggestion menu disappeared and
  // the composer now contains a GitHub token-shaped value, accept it. We do
  // not perform a second @GitHub injection or a fallback navigation click.
  const textAfterCommit = await composerText(page);
  return !await hasVisibleGitHubMenu(page) && /GitHub/i.test(textAfterCommit) && !/@GitHub/i.test(textAfterCommit);
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