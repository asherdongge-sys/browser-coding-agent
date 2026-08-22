import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserAgent, BrowserAgentEvent, BrowserAgentMessage, BrowserProvider } from "./browser-provider.js";
import { BrowserTaskExecutor } from "./browser-task-executor.js";

const CHATGPT_URL = "https://chatgpt.com/";
const DASHBOARD_URL = process.env.BROWSER_CODING_AGENT_DASHBOARD_URL ?? "http://127.0.0.1:4317/";
const RESPONSE_TIMEOUT_MS = 120000;
const STABILITY_MS = 1000;
const BROWSER_TASK_PREFIX = "::browser-task::";
const GITHUB_APP_NAME = "GitHub";

type ManagedAgent = BrowserAgent & { page: Page };
type Snapshot = { text: string; count: number };
export type PlaywrightBrowserProviderOptions = { profileDir?: string; headless?: boolean; executablePath?: string; onEvent?: (event: BrowserAgentEvent) => void };

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly kind = "playwright" as const;
  private context: BrowserContext | undefined;
  private dashboardPage: Page | undefined;
  private startPromise: Promise<void> | undefined;
  private stopping = false;
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly executablePath: string | undefined;
  private readonly onEvent: ((event: BrowserAgentEvent) => void) | undefined;

  constructor(options: PlaywrightBrowserProviderOptions = {}) {
    this.profileDir = options.profileDir ?? process.env.BROWSER_CODING_AGENT_PROFILE ?? ".browser-coding-agent/chromium";
    this.headless = options.headless ?? process.env.BROWSER_CODING_AGENT_HEADLESS === "1";
    this.executablePath = options.executablePath ?? (process.env.BROWSER_EXECUTABLE?.trim() || undefined);
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.context) return;
    if (this.stopping) throw new Error("Browser provider is stopping");
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  async listAgents(): Promise<BrowserAgent[]> { return [...this.agents.values()].map(({ page: _page, ...agent }) => agent); }

  async createAgent(title: string, prompt: string): Promise<BrowserAgent> {
    await this.start();
    if (this.stopping || !this.context) throw new Error("Browser provider is not running");
    const page = await this.context.newPage();
    const normalizedPrompt = prompt.trim();
    const agent: ManagedAgent = { id: crypto.randomUUID(), title: title.trim() || `Agent ${new Date().toLocaleTimeString()}`, ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}), status: "opening-chatgpt", createdAt: Date.now(), updatedAt: Date.now(), messages: [], page };
    this.agents.set(agent.id, agent);
    this.observePage(page);
    this.emit({ type: "agent.created", agent: this.publicAgent(agent) });
    await this.keepDashboardForeground();
    void this.initializeAgent(agent);
    return this.publicAgent(agent);
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    if (text.startsWith(BROWSER_TASK_PREFIX)) { await this.runTask(agentId, text.slice(BROWSER_TASK_PREFIX.length).trim()); return; }
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    await this.send(agent, text);
  }

  async resumeAgent(agentId: string): Promise<BrowserAgent> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    await this.initializeAgent(agent);
    return this.publicAgent(agent);
  }

  async runTask(agentId: string, goal: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (!goal.trim()) throw new Error("Agent goal must not be empty");
    await this.ensurePageReady(agent);
    if (!await this.isAuthenticated(agent.page)) throw new Error("ChatGPT is not logged in");
    const conversationUrl = agent.conversationUrl || agent.page.url();
    const startedAt = Date.now();
    this.patch(agent, { status: "planning", lastError: "" });
    this.emitTaskMessage(agent, `浏览器任务开始：${goal}`);
    const taskPage = await this.context!.newPage();
    this.observePage(taskPage);
    const executor = new BrowserTaskExecutor(taskPage, (kind, call, result) => {
      if (kind === "call") { this.emit({ type: "agent.tool.call", agentId: agent.id, call }); this.patch(agent, { status: "inspecting" }); }
      else if (result) this.emit({ type: "agent.tool.result", agentId: agent.id, call, result });
      void this.keepDashboardForeground();
    });
    try {
      const summary = await executor.run(goal);
      if (!taskPage.isClosed()) await taskPage.close();
      this.emitTaskMessage(agent, `浏览器任务完成：${summary || "操作已完成"}\n耗时：${Date.now() - startedAt}ms`);
      this.patch(agent, { status: "completed", conversationUrl, lastError: "" });
      await this.persist();
    } catch (error) {
      if (!taskPage.isClosed()) await taskPage.close().catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.emitTaskMessage(agent, `浏览器任务失败：${message}`);
      this.patch(agent, { status: "failed", lastError: message });
      throw error;
    } finally { await this.keepDashboardForeground(); }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const context = this.context;
    this.context = undefined;
    this.dashboardPage = undefined;
    this.agents.clear();
    if (context) await context.close().catch((error) => console.error("[BrowserCodingAgent] Playwright context close failed:", error));
  }

  private async startInternal(): Promise<void> {
    const context = await chromium.launchPersistentContext(this.profileDir, { headless: this.headless, viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true, ignoreDefaultArgs: ["--no-sandbox"], ...(this.executablePath ? { executablePath: this.executablePath } : {}) });
    this.context = context;
    const startupPage = context.pages()[0] ?? await context.newPage();
    this.observePage(startupPage);
    this.dashboardPage = startupPage;
    await this.openDashboard(startupPage);
    for (const page of context.pages()) if (page !== startupPage) this.observePage(page);
    await this.keepDashboardForeground();
  }

  private async openDashboard(page: Page): Promise<void> {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      if (this.stopping) throw new Error("Browser provider is stopping");
      try { if (page.url() !== DASHBOARD_URL) await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 3000 }); return; }
      catch (error) { if (attempt === 20) throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  }

  private async keepDashboardForeground(): Promise<void> { const page = this.dashboardPage; if (!page || page.isClosed() || this.headless || this.stopping) return; await page.bringToFront().catch(() => undefined); }

  private async initializeAgent(agent: ManagedAgent): Promise<void> {
    try {
      if (this.stopping || agent.page.isClosed()) throw new Error("Agent browser page is unavailable");
      this.patch(agent, { status: "opening-chatgpt", lastError: "" });
      const target = agent.conversationUrl || CHATGPT_URL;
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(agent.page.url()) || agent.page.url() === "about:blank") await agent.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.waitForComposerOrLogin(agent.page, 30000);
      if (!await this.isAuthenticated(agent.page)) { this.patch(agent, { status: "login-required", lastError: "请在托管的 Chromium 中完成 ChatGPT 登录，然后点击继续。" }); return; }
      this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
      if (agent.prompt) { const prompt = agent.prompt; delete agent.prompt; await this.send(agent, prompt); }
    } catch (error) { if (!this.stopping) this.patch(agent, { status: "failed", lastError: error instanceof Error ? error.message : String(error) }); }
    finally { await this.keepDashboardForeground(); }
  }

  private async send(agent: ManagedAgent, text: string): Promise<void> {
    const message = text.trim();
    if (!message) throw new Error("Message cannot be empty");
    await this.ensurePageReady(agent);
    if (!await this.isAuthenticated(agent.page)) throw new Error("ChatGPT is not logged in");
    const previousAssistant = await this.latestAssistant(agent.page);
    const previousUser = await this.latestUser(agent.page);
    const createdAt = Date.now();
    this.patch(agent, { status: "sending", lastError: "" });
    this.pushMessage(agent, { role: "user", text: message, createdAt });
    this.emit({ type: "agent.message", agentId: agent.id, role: "user", text: message, url: agent.page.url(), createdAt });
    if (this.looksLikeGitHubRequest(message) && await this.selectChatGPTApp(agent.page, GITHUB_APP_NAME)) await this.submitComposerAfterAppSelection(agent.page, message);
    else await this.submitComposer(agent.page, message);
    this.patch(agent, { status: "waiting", conversationUrl: agent.page.url() });
    await this.waitForUserTurn(agent.page, previousUser, message);
    const response = await this.waitForAssistant(agent.page, previousAssistant, agent);
    this.finalizeAssistant(agent, response);
    this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
    await this.persist();
  }

  private looksLikeGitHubRequest(text: string): boolean { return /\bgithub\b|\brepositories?\b|\brepos?\b|\bpull requests?\b|\bissues?\b|\bcommits?\b|\bbranches?\b|仓库|代码仓库|GitHub|拉取请求|分支|提交记录/i.test(text); }

  private async selectChatGPTApp(page: Page, appName: string): Promise<boolean> {
    try {
      await this.waitForComposerOrLogin(page, 5000);
      const target = await this.findComposer(page);
      if (!target) return false;
      const composer = page.locator(target.kind === "contenteditable" ? "[contenteditable='true']" : target.kind === "textarea" ? "textarea" : "[role='textbox']").nth(target.index);
      if (!await this.isUsableElement(composer)) return false;
      await composer.click({ timeout: 5000 });
      // One continuous @GitHub gesture: never append another @ while the menu is open.
      await composer.pressSequentially(`@${appName}`, { delay: 35 });
      if (await this.waitAndClickApp(page, appName, 4500)) return true;
      // ChatGPT also accepts the currently highlighted @GitHub suggestion with Space.
      await composer.press("Space").catch(() => undefined);
      await page.waitForTimeout(350);
      if (await this.isAppMentionActive(page, appName)) return true;
      // Last resort: click the first visible GitHub candidate even if it has no semantic menu role.
      if (await this.waitAndClickApp(page, appName, 1500)) return true;
      await composer.press("Escape").catch(() => undefined);
      await this.clearComposerMention(composer);
    } catch (error) {
      console.warn(`[BrowserCodingAgent] ChatGPT App selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const plusSelectors = ['button[aria-label*="Add" i]', 'button[aria-label*="添加" i]', 'button[data-testid*="composer" i]', 'button[data-testid*="attach" i]'];
    for (const selector of plusSelectors) {
      try {
        const buttons = page.locator(selector);
        for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
          const button = buttons.nth(index);
          if (!await this.isUsableElement(button)) continue;
          await button.click({ timeout: 3000 });
          if (await this.waitAndClickApp(page, appName, 2500)) return true;
        }
      } catch { continue; }
    }
    return false;
  }

  private async waitAndClickApp(page: Page, appName: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const candidates = page.getByText(appName, { exact: true });
        for (let index = await candidates.count() - 1; index >= 0; index -= 1) {
          const candidate = candidates.nth(index);
          if (!await this.isUsableElement(candidate)) continue;
          // Do not require a specific role: ChatGPT may render the App suggestion as a div/list item.
          await candidate.click({ timeout: 1500 }).catch(async () => {
            const parent = candidate.locator("..", { has: candidate }).first();
            if (await this.isUsableElement(parent)) await parent.click({ timeout: 1500 });
            else throw new Error("GitHub candidate is not clickable");
          });
          await page.waitForTimeout(250);
          return true;
        }
      } catch { /* page may be navigating or menu may still be rendering; retry */ }
      await page.waitForTimeout(150);
    }
    return false;
  }

  private async isAppMentionActive(page: Page, appName: string): Promise<boolean> {
    try {
      return await page.evaluate((name) => {
        const visible = (node: HTMLElement) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1; };
        const bodyText = document.body?.innerText ?? "";
        const composerNodes = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']"));
        const composer = composerNodes.reverse().find(visible);
        const value = composer?.textContent ?? (composer as HTMLTextAreaElement | undefined)?.value ?? "";
        const menuStillOpen = Array.from(document.querySelectorAll<HTMLElement>("[role='option'], [role='menuitem'], [role='listbox']")).some(visible);
        return (value.includes(name) && !value.includes(`@${name}`)) || (!menuStillOpen && bodyText.includes(name));
      }, appName);
    } catch { return false; }
  }

  private async clearComposerMention(composer: ReturnType<Page["locator"]>): Promise<void> {
    try { await composer.press("Control+A"); await composer.press("Backspace"); } catch { /* best effort */ }
  }

  private async submitComposerAfterAppSelection(page: Page, text: string): Promise<void> {
    const target = await this.findComposer(page);
    if (!target) throw new Error("ChatGPT composer is not visible after selecting GitHub");
    const composer = page.locator(target.kind === "contenteditable" ? "[contenteditable='true']" : target.kind === "textarea" ? "textarea" : "[role='textbox']").nth(target.index);
    if (!await this.isUsableElement(composer)) throw new Error("ChatGPT composer is not usable after selecting GitHub");
    await composer.click({ timeout: 5000 });
    await composer.pressSequentially(text, { delay: 5 });
    await this.clickSendButton(page, composer);
  }

  private async submitComposer(page: Page, text: string): Promise<void> {
    const target = await this.findComposer(page);
    if (!target) throw new Error("ChatGPT composer is not visible");
    const composer = page.locator(target.kind === "contenteditable" ? "[contenteditable='true']" : target.kind === "textarea" ? "textarea" : "[role='textbox']").nth(target.index);
    await composer.fill(text);
    await this.clickSendButton(page, composer);
  }

  private async clickSendButton(page: Page, composer: ReturnType<Page["locator"]>): Promise<void> {
    for (const selector of ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]', 'button[type="submit"]']) {
      const buttons = page.locator(selector);
      for (let index = await buttons.count() - 1; index >= 0; index -= 1) {
        const button = buttons.nth(index);
        if (!await this.isUsableElement(button)) continue;
        if (await button.isDisabled().catch(() => true)) continue;
        await button.click({ timeout: 5000 });
        return;
      }
    }
    await composer.press("Enter");
  }

  private async ensurePageReady(agent: ManagedAgent): Promise<void> { if (this.stopping || agent.page.isClosed()) throw new Error("Agent browser page is unavailable"); if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(agent.page.url())) await agent.page.goto(agent.conversationUrl || CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 }); await this.waitForComposerOrLogin(agent.page, 30000); }
  private async waitForComposerOrLogin(page: Page, timeoutMs: number): Promise<void> { await page.waitForFunction(() => { const body = document.body?.innerText ?? ""; const nodes = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']")); const usable = nodes.some((node) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 10; }); return usable || /log in|sign in|登录|注册/i.test(body) || /\/auth\//i.test(location.pathname); }, undefined, { timeout: timeoutMs }); }
  private async isAuthenticated(page: Page): Promise<boolean> { try { return await page.evaluate(() => { if (/\/auth\//i.test(location.pathname) || /\/login/i.test(location.pathname)) return false; return Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']")).some((node) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 10; }); }); } catch { return false; } }
  private async findComposer(page: Page): Promise<{ kind: "contenteditable" | "textarea" | "role"; index: number } | undefined> { try { return await page.evaluate(() => { const groups = [["[contenteditable='true']", "contenteditable"], ["textarea", "textarea"], ["[role='textbox']", "role"]] as const; for (const [selector, kind] of groups) { const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector)); for (let index = nodes.length - 1; index >= 0; index -= 1) { const node = nodes[index]; if (!node) continue; const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 10) return { kind, index }; } } return undefined; }); } catch { return undefined; } }
  private async isUsableElement(locator: ReturnType<Page["locator"]>): Promise<boolean> { return locator.evaluate((node) => { const element = node as HTMLElement; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1; }).catch(() => false); }
  private async latestAssistant(page: Page): Promise<Snapshot> { return page.evaluate(() => { const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='assistant']")); const texts = [...new Set(nodes)].map((node) => node.innerText.trim()).filter(Boolean); return { text: texts.at(-1) ?? "", count: texts.length }; }); }
  private async latestUser(page: Page): Promise<Snapshot> { return page.evaluate(() => { const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='user']")); const texts = [...new Set(nodes)].map((node) => node.innerText.trim()).filter(Boolean); return { text: texts.at(-1) ?? "", count: texts.length }; }); }
  private async waitForUserTurn(page: Page, previous: Snapshot, expected: string): Promise<void> { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const current = await this.latestUser(page); if (current.count > previous.count || current.text === expected.trim()) return; await page.waitForTimeout(250); } throw new Error("ChatGPT did not accept the user message"); }
  private async waitForAssistant(page: Page, previous: Snapshot, agent: ManagedAgent): Promise<string> { const deadline = Date.now() + RESPONSE_TIMEOUT_MS; let last = ""; let stableSince = 0; let streamed = ""; while (Date.now() < deadline) { const current = await this.latestAssistant(page); const changed = current.count > previous.count || (current.text.length > 0 && current.text !== previous.text); if (changed && current.text) { if (current.text !== streamed) { streamed = current.text; this.updateStreamingAssistant(agent, streamed); this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text: streamed, url: agent.page.url(), createdAt: Date.now(), streaming: true }); } if (current.text !== last) { last = current.text; stableSince = Date.now(); } if (Date.now() - stableSince >= STABILITY_MS) return current.text; } await page.waitForTimeout(400); } throw new Error("Timed out waiting for ChatGPT response after 120s"); }
  private ensureMessages(agent: ManagedAgent): BrowserAgentMessage[] { if (!agent.messages) agent.messages = []; return agent.messages; }
  private pushMessage(agent: ManagedAgent, message: BrowserAgentMessage): void { this.ensureMessages(agent).push(message); void this.persist(); }
  private updateStreamingAssistant(agent: ManagedAgent, text: string): void { const messages = this.ensureMessages(agent); const last = messages.at(-1); if (last?.role === "assistant") last.text = text; else messages.push({ role: "assistant", text, createdAt: Date.now() }); }
  private finalizeAssistant(agent: ManagedAgent, text: string): void { const messages = this.ensureMessages(agent); const last = messages.at(-1); if (last?.role === "assistant") last.text = text; else messages.push({ role: "assistant", text, createdAt: Date.now() }); this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text, url: agent.page.url(), createdAt: Date.now(), streaming: false }); }
  private emitTaskMessage(agent: ManagedAgent, text: string): void { this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text, url: agent.page.url(), createdAt: Date.now(), streaming: false }); }
  private emit(event: BrowserAgentEvent): void { this.onEvent?.(event); }
  private patch(agent: ManagedAgent, patch: Partial<BrowserAgent>): void { Object.assign(agent, patch, { updatedAt: Date.now() }); this.emit({ type: "agent.updated", agent: this.publicAgent(agent) }); }
  private publicAgent(agent: ManagedAgent): BrowserAgent { const { page: _page, ...publicAgent } = agent; return publicAgent; }
  private async persist(): Promise<void> {}
  private observePage(_page: Page): void {}
}
