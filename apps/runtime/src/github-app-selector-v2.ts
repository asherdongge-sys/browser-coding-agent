import type { Page } from "playwright";

type Composer = ReturnType<Page["locator"]>;
const inFlight = new WeakMap<Page, Promise<boolean>>();
const results = new WeakMap<Page, boolean>();
const selectedComposers = new WeakMap<Page, Composer>();

function isConversationPage(page: Page): boolean {
  try { const url = new URL(page.url()); return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && !/^\/(apps|gpts)(?:\/|$)/i.test(url.pathname); } catch { return false; }
}

async function findComposer(page: Page): Promise<Composer | undefined> {
  for (const selector of ["[contenteditable='true']:not([aria-hidden='true'])","textarea[name='prompt-textarea']:not(.wcDTda_fallbackTextarea)","textarea:not(.wcDTda_fallbackTextarea)","[role='textbox']:not([aria-hidden='true'])"]) {
    const nodes = page.locator(selector);
    for (let i = await nodes.count() - 1; i >= 0; i--) { const node = nodes.nth(i); if (await node.isVisible().catch(() => false)) return node; }
  }
  return undefined;
}

async function waitForComposer(page: Page, timeoutMs = 30000): Promise<Composer | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!isConversationPage(page)) return undefined; const composer = await findComposer(page); if (composer) return composer; await page.waitForTimeout(300); }
  return undefined;
}

async function visible(node: import("playwright").Locator): Promise<boolean> { return node.isVisible().catch(() => false); }

async function hasVisibleGitHubMenu(page: Page): Promise<boolean> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>("[role='option'],[role='menuitem'],[role='listbox'],[data-radix-menu-content]"))
    .some((node) => { const s=getComputedStyle(node), r=node.getBoundingClientRect(); return s.display!=="none"&&s.visibility!=="hidden"&&r.width>1&&r.height>1&&/github/i.test(node.innerText||node.textContent||""); })).catch(() => false);
}

async function hasCommittedGitHubMention(page: Page): Promise<boolean> {
  if (!isConversationPage(page)) return false;
  return page.evaluate(() => {
    const visible=(n:HTMLElement)=>{const s=getComputedStyle(n),r=n.getBoundingClientRect();return s.display!=="none"&&s.visibility!=="hidden"&&r.width>1&&r.height>1;};
    const composer=Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'],textarea,[role='textbox']")).reverse().find(visible);
    if (!composer) return false;
    if (Array.from(composer.querySelectorAll<HTMLElement>("[data-mention],[data-testid*='mention' i],[aria-label*='GitHub' i],[data-app-id*='github' i]")).some(visible)) return true;
    const text=`${composer.textContent??""} ${(composer as HTMLTextAreaElement).value??""}`.trim();
    return /GitHub/i.test(text)&&!/@GitHub/i.test(text)&&!Array.from(document.querySelectorAll<HTMLElement>("[role='option'],[role='menuitem'],[role='listbox'],[data-radix-menu-content]")).some(visible);
  }).catch(() => false);
}

async function composerText(composer: Composer): Promise<string> { return composer.evaluate((node)=>`${node.textContent??""} ${(node as HTMLTextAreaElement).value??""}`).catch(()=>""); }

async function clearComposer(composer: Composer): Promise<void> { await composer.click({timeout:5000}).catch(()=>undefined); await composer.press("Control+A").catch(()=>undefined); await composer.press("Backspace").catch(()=>undefined); await composer.press("Escape").catch(()=>undefined); await composer.click({timeout:5000}).catch(()=>undefined); }

async function selectGitHubInternal(page: Page): Promise<boolean> {
  const composer=await waitForComposer(page); if(!composer) return false;
  if(await hasCommittedGitHubMention(page)){selectedComposers.set(page,composer);return true;}
  const existing=await composerText(composer); if(/@GitHub/i.test(existing)) await clearComposer(composer);

  // One and only one @GitHub transaction per page. Do not use generic text
  // clicks: those can navigate to /apps/github and trigger rate limits.
  await composer.click({timeout:5000});
  await composer.pressSequentially("@GitHub",{delay:25});
  await page.waitForTimeout(350);
  if(!isConversationPage(page)) return false;
  await composer.press("Space").catch(()=>undefined);
  await page.waitForTimeout(600);
  if(!isConversationPage(page)) return false;
  const selected=await hasCommittedGitHubMention(page);
  if(selected){selectedComposers.set(page,composer);return true;}
  // Never retry on this page. A failed attempt must not produce another @GitHub.
  return false;
}

export function ensureGitHubSelectedV2(page: Page,_appName="GitHub"): Promise<boolean>{
  const cached=results.get(page); if(cached!==undefined) return Promise.resolve(cached);
  const running=inFlight.get(page); if(running) return running;
  const promise=selectGitHubInternal(page).then(selected=>{results.set(page,selected);return selected;}).catch(()=>{results.set(page,false);return false;}).finally(()=>inFlight.delete(page));
  inFlight.set(page,promise); return promise;
}

/** Select GitHub and type the prompt through the same composer without a second focus transaction. */
export async function submitMessageAfterGitHubSelection(page: Page,text: string): Promise<void>{
  const composer=selectedComposers.get(page)??await findComposer(page); if(!composer) throw new Error("ChatGPT composer is not available after selecting GitHub");
  // The active element can change when ChatGPT commits the app chip. Targeting
  // the same locator is safer than page.keyboard.type(), which may type into a
  // rerendered editor and cause the app chip to disappear.
  await composer.pressSequentially(text,{delay:5});
  for(const selector of ['button[data-testid="send-button"]','button[aria-label*="Send" i]','button[aria-label*="发送" i]','button[type="submit"]']){
    const buttons=page.locator(selector);
    for(let i=await buttons.count()-1;i>=0;i--){const button=buttons.nth(i);if(!await visible(button))continue;if(await button.isDisabled().catch(()=>true))continue;await button.click({timeout:5000});return;}
  }
  await composer.press("Enter");
}
