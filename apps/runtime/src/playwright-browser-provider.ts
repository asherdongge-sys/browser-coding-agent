import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserAgent, BrowserAgentEvent, BrowserAgentMessage, BrowserProvider } from "./browser-provider.js";
import { BrowserTaskExecutor } from "./browser-task-executor.js";

const CHATGPT_URL = "https://chatgpt.com/";
const DASHBOARD_URL = process.env.BROWSER_CODING_AGENT_DASHBOARD_URL ?? "http://127.0.0.1:4317/";
const RESPONSE_TIMEOUT_MS = 120000;
const STABILITY_MS = 1000;
const BROWSER_TASK_PREFIX = "::browser-task::";

type ManagedAgent = BrowserAgent & { page: Page };
type AssistantSnapshot = { text: string; count: number };
type UserSnapshot = { text: string; count: number };

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
    this.observePage(page);
    const normalizedPrompt = prompt.trim();
    const agent: ManagedAgent = { id: crypto.randomUUID(), title: title.trim() || `Agent ${new Date().toLocaleTimeString()}`, ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}), status: "opening-chatgpt", createdAt: Date.now(), updatedAt: Date.now(), messages: [], page };
    this.agents.set(agent.id, agent);
    this.emit({ type: "agent.created", agent: this.publicAgent(agent) });
    void this.initializeAgent(agent);
    return this.publicAgent(agent);
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    if (text.startsWith(BROWSER_TASK_PREFIX)) {
      await this.runTask(agentId, text.slice(BROWSER_TASK_PREFIX.length).trim());
      return;
    }
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
    this.patch(agent, { status: "planning", lastError: "" });
    const executor = new BrowserTaskExecutor(agent.page, (kind, call, result) => {
      if (kind === "call") { this.emit({ type: "agent.tool.call", agentId: agent.id, call }); this.patch(agent, { status: "inspecting" }); }
      else if (result) this.emit({ type: "agent.tool.result", agentId: agent.id, call, result });
    });
    try {
      const summary = await executor.run(goal);
      agent.messages.push({ role: "assistant", text: summary, createdAt: Date.now() });
      this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text: summary, url: agent.page.url(), createdAt: Date.now(), streaming: false });
      this.patch(agent, { status: "completed", conversationUrl: agent.page.url(), lastError: "" });
      await this.persist();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    if (context) { try { await context.close(); } catch (error) { console.error("[BrowserCodingAgent] Playwright context close failed:", error); } }
  }

  private async startInternal(): Promise<void> {
    const context = await chromium.launchPersistentContext(this.profileDir, { headless: this.headless, viewport: { width: 1440, height: 900 }, ignoreDefaultArgs: ["--no-sandbox"], ...(this.executablePath ? { executablePath: this.executablePath } : {}) });
    this.context = context;
    if (this.stopping) { await context.close(); this.context = undefined; throw new Error("Browser provider stopped during startup"); }
    const startupPage = context.pages()[0] ?? await context.newPage();
    this.observePage(startupPage); this.dashboardPage = startupPage; await this.openDashboard(startupPage);
    for (const page of context.pages()) if (page !== startupPage) this.observePage(page);
  }

  private async openDashboard(page: Page): Promise<void> {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      if (this.stopping) throw new Error("Browser provider is stopping");
      try { if (page.url() !== DASHBOARD_URL) await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 3000 }); return; }
      catch (error) { if (attempt === 20) throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
  }

  private async keepDashboardForeground(): Promise<void> { const dashboard = this.dashboardPage; if (!dashboard || dashboard.isClosed() || this.headless || this.stopping) return; try { await dashboard.bringToFront(); } catch {} }

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
    const message = text.trim(); if (!message) throw new Error("Message cannot be empty");
    await this.ensurePageReady(agent); if (!await this.isAuthenticated(agent.page)) throw new Error("ChatGPT is not logged in");
    const previousAssistant = await this.latestAssistant(agent.page); const previousUser = await this.latestUser(agent.page); const createdAt = Date.now();
    this.patch(agent, { status: "sending", lastError: "" }); this.pushMessage(agent, { role: "user", text: message, createdAt });
    this.emit({ type: "agent.message", agentId: agent.id, role: "user", text: message, url: agent.page.url(), createdAt });
    await this.submitComposer(agent.page, message); this.patch(agent, { status: "waiting", conversationUrl: agent.page.url() });
    await this.waitForUserTurn(agent.page, previousUser, message); const response = await this.waitForAssistant(agent.page, previousAssistant, agent);
    this.finalizeAssistant(agent, response); this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" }); await this.persist();
  }

  private pushMessage(agent: ManagedAgent, message: BrowserAgentMessage): void { agent.messages.push(message); void this.persist(); }
  private finalizeAssistant(agent: ManagedAgent, text: string): void { const last = agent.messages.at(-1); if (last?.role === "assistant") last.text = text; else agent.messages.push({ role: "assistant", text, createdAt: Date.now() }); this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text, url: agent.page.url(), createdAt: Date.now(), streaming: false }); }
  private async ensurePageReady(agent: ManagedAgent): Promise<void> { if (this.stopping || agent.page.isClosed()) throw new Error("Agent browser page is unavailable"); if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(agent.page.url())) await agent.page.goto(agent.conversationUrl || CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 }); await this.waitForComposerOrLogin(agent.page, 30000); }
  private async waitForComposerOrLogin(page: Page, timeoutMs: number): Promise<void> { await page.waitForFunction(() => { const body = document.body?.innerText ?? ""; const candidates = Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']")); const usable = candidates.some((node) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 10; }); return usable || /log in|sign in|登录|注册/i.test(body) || /\/auth\//i.test(location.pathname); }, undefined, { timeout: timeoutMs }); }
  private async isAuthenticated(page: Page): Promise<boolean> { return page.evaluate(() => { if (/\/auth\//i.test(location.pathname) || /\/login/i.test(location.pathname)) return false; return Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']")).some((node) => { const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 10; }); }); }
  private async submitComposer(page: Page, text: string): Promise<void> { const target = await this.findComposer(page); if (!target) throw new Error("ChatGPT composer is not visible"); const { kind, index } = target; const locator = page.locator(kind === "contenteditable" ? "[contenteditable='true']" : kind === "textarea" ? "textarea" : "[role='textbox']").nth(index); await locator.fill(text); await page.waitForFunction((expected) => Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']")).some((node) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); if (style.display === "none" || style.visibility === "hidden" || rect.width <= 20 || rect.height <= 10) return false; const value = node instanceof HTMLTextAreaElement ? node.value : node.innerText || node.textContent || ""; return value.trim() === String(expected).trim(); }), text, { timeout: 5000 }); for (const selector of ['button[data-testid="send-button"]', 'button[aria-label*="Send" i]', 'button[aria-label*="发送" i]', 'button[type="submit"]']) { const buttons = page.locator(selector); const count = await buttons.count(); for (let index = count - 1; index >= 0; index -= 1) { const button = buttons.nth(index); if (!await this.isUsableElement(button)) continue; if (await button.isDisabled().catch(() => true)) continue; await button.click({ timeout: 5000 }); return; } } await locator.press("Enter"); }
  private async findComposer(page: Page): Promise<{ kind: "contenteditable" | "textarea" | "role"; index: number } | undefined> { return page.evaluate(() => { const groups = [["[contenteditable='true']", "contenteditable"], ["textarea", "textarea"], ["[role='textbox']", "role"]] as const; for (const [selector, kind] of groups) { const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector)); for (let index = nodes.length - 1; index >= 0; index -= 1) { const node = nodes[index]; const style = getComputedStyle(node); const rect = node.getBoundingClientRect(); if (style.display !== "none" && style.visibility !== "hidden" && rect.width > 20 && rect.height > 10) return { kind, index }; } } return undefined; }); }
  private async isUsableElement(locator: ReturnType<Page["locator"]>): Promise<boolean> { return locator.evaluate((node) => { const element = node as HTMLElement; const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 1 && rect.height > 1; }).catch(() => false); }
  private async latestAssistant(page: Page): Promise<AssistantSnapshot> { return page.evaluate(() => { const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='assistant']")); const texts = [...new Set(nodes)].map((node) => node.innerText.trim()).filter(Boolean); return { text: texts.at(-1) ?? "", count: texts.length }; }); }
  private async latestUser(page: Page): Promise<UserSnapshot> { return page.evaluate(() => { const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='user']")); const texts = [...new Set(nodes)].map((node) => node.innerText.trim()).filter(Boolean); return { text: texts.at(-1) ?? "", count: texts.length }; }); }
  private async waitForUserTurn(page: Page, previous: UserSnapshot, expected: string): Promise<void> { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const current = await this.latestUser(page); if (current.count > previous.count || current.text === expected.trim()) return; await page.waitForTimeout(250); } throw new Error("ChatGPT did not accept the user message"); }
  private async waitForAssistant(page: Page, previous: AssistantSnapshot, agent: ManagedAgent): Promise<string> { const deadline = Date.now() + RESPONSE_TIMEOUT_MS; let last = ""; let stableSince = 0; let streamed = ""; while (Date.now() < deadline) { const current = await this.latestAssistant(page); const changed = current.count > previous.count || (current.text.length > 0 && current.text !== previous.text); if (changed && current.text) { if (current.text !== streamed) { streamed = current.text; this.updateStreamingAssistant(agent, streamed); this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text: streamed, url: agent.page.url(), createdAt: Date.now(), streaming: true }); } if (current.text !== last) { last = current.text; stableSince = Date.now(); } if (Date.now() - stableSince >= STABILITY_MS) return current.text; } await page.waitForTimeout(400); } throw new Error("Timed out waiting for ChatGPT response after 120s"); }
  private updateStreamingAssistant(agent: ManagedAgent, text: string): void { const last = agent.messages.at(-1); if (last?.role === "assistant") last.text = text; else agent.messages.push({ role: "assistant", text, createdAt: Date.now() }); void this.persist(); }
  private observePage(page: Page): void { page.on("close", () => { if (this.dashboardPage === page) this.dashboardPage = undefined; for (const agent of this.agents.values()) if (agent.page === page) this.patch(agent, { status: "tab-closed", lastError: "浏览器页面已关闭" }); }); }
  private patch(agent: ManagedAgent, patch: Partial<BrowserAgent>): void { Object.assign(agent, patch, { updatedAt: Date.now() }); this.emit({ type: "agent.updated", agent: this.publicAgent(agent) }); if (patch.status) this.emit({ type: "agent.state", agentId: agent.id, state: patch.status, url: agent.page.url() }); }
  private publicAgent(agent: ManagedAgent): BrowserAgent { const { page: _page, ...publicAgent } = agent; return publicAgent; }
  private emit(event: BrowserAgentEvent): void { try { this.onEvent?.(event); } catch (error) { console.error("[BrowserCodingAgent] event handler failed:", error); } }
  private async persist(): Promise<void> { /* existing runtime persistence hook */ }
}
