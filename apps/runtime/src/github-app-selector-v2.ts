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

async function hasCommittedGitHubMention(page: Page): Promise<boolean> {
  if (!isConversationPage(page)) return false;
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1; };
    const composerNodes = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']"));
    const composer = composerNodes.reverse().find(visible);
    if (!composer) return false;
    const explicit = Array.from(composer.querySelectorAll<HTMLElement>("[data-mention], [data-testid*='mention' i], [aria-label*='GitHub' i]")).some(visible);
    if (explicit) return true;
    const text = `${composer.textContent ?? ""} ${(composer as HTMLTextAreaElement).value ?? ""}`;
    const menuOpen = Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], [role='listbox']")).some(visible);
    return /(^|\s)@GitHub(?:\s|$)/i.test(text) && !menuOpen;
  }).catch(() => false);
}

async function visibleGitHubOption(page: Page): Promise<ReturnType<Page["locator"]> | undefined> {
  const options = page.getByText("GitHub", { exact: true });
  for (let i = await options.count() - 1; i >= 0; i -= 1) {
    const option = options.nth(i);
    if (!await option.isVisible().catch(() => false)) continue;
    const navigation = await option.evaluate((node) => Boolean(node.closest("a[href], [href]"))).catch(() => true);
    if (!navigation) return option;
  }
  return undefined;
}

async function selectGitHubInternal(page: Page): Promise<boolean> {
  const composer = await waitForComposer(page);
  if (!composer) return false;
  if (await hasCommittedGitHubMention(page)) return true;
  await composer.click({ timeout: 5000 });
  await composer.pressSequentially("@GitHub", { delay: 35 });
  await page.waitForTimeout(350);
  if (!isConversationPage(page)) return false;
  await composer.press("Space").catch(() => undefined);
  await page.waitForTimeout(500);
  if (!isConversationPage(page)) return false;
  if (await hasCommittedGitHubMention(page)) return true;
  const option = await visibleGitHubOption(page);
  if (option) {
    await option.click({ timeout: 2000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    if (isConversationPage(page) && await hasCommittedGitHubMention(page)) return true;
  }
  return false;
}

export function ensureGitHubSelectedV2(page: Page, _appName = "GitHub"): Promise<boolean> {
  const cached = results.get(page);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = inFlight.get(page);
  if (running) return running;
  const promise = selectGitHubInternal(page).then((selected) => { results.set(page, selected); return selected; }).catch(() => { results.set(page, false); return false; }).finally(() => inFlight.delete(page));
  inFlight.set(page, promise);
  return promise;
}
