import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserAgent, BrowserAgentEvent, BrowserProvider } from "./browser-provider.js";

const CHATGPT_URL = "https://chatgpt.com/";
const DASHBOARD_URL = process.env.BROWSER_CODING_AGENT_DASHBOARD_URL ?? "http://127.0.0.1:4317/";
const RESPONSE_TIMEOUT_MS = 120000;
const STABILITY_MS = 1000;
const TURN_IDLE_TIMEOUT_MS = 30000;

export type PlaywrightBrowserProviderOptions = {
  profileDir?: string;
  headless?: boolean;
  executablePath?: string;
  onEvent?: (event: BrowserAgentEvent) => void;
};

type ManagedAgent = BrowserAgent & { page: Page };
type AssistantSnapshot = { text: string; count: number };

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

  async listAgents(): Promise<BrowserAgent[]> {
    return [...this.agents.values()].map(({ page: _page, ...agent }) => agent);
  }

  async createAgent(title: string, prompt: string): Promise<BrowserAgent> {
    await this.start();
    if (this.stopping || !this.context) throw new Error("Browser provider is not running");

    const page = await this.context.newPage();
    this.observePage(page);
    const normalizedPrompt = prompt.trim();
    const agent: ManagedAgent = {
      id: crypto.randomUUID(),
      title: title.trim() || `Agent ${new Date().toLocaleTimeString()}`,
      ...(normalizedPrompt ? { prompt: normalizedPrompt } : {}),
      status: "opening-chatgpt",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      page,
    };

    this.agents.set(agent.id, agent);
    this.emit({ type: "agent.created", agent: this.publicAgent(agent) });
    await this.keepDashboardForeground();
    void this.initializeAgent(agent);
    return this.publicAgent(agent);
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    await this.send(agent, text);
    await this.keepDashboardForeground();
  }

  async resumeAgent(agentId: string): Promise<BrowserAgent> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);
    await this.initializeAgent(agent);
    await this.keepDashboardForeground();
    return this.publicAgent(agent);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const context = this.context;
    this.context = undefined;
    this.dashboardPage = undefined;
    this.agents.clear();
    if (context) {
      try { await context.close(); }
      catch (error) { console.error("[BrowserCodingAgent] Playwright context close failed:", error); }
    }
    if (this.startPromise) {
      try { await this.startPromise; } catch { /* startup failure already reported */ }
    }
  }

  private async startInternal(): Promise<void> {
    const launchOptions = {
      headless: this.headless,
      viewport: { width: 1440, height: 900 },
      ignoreDefaultArgs: ["--no-sandbox"],
      ...(this.executablePath ? { executablePath: this.executablePath } : {}),
    };
    const context = await chromium.launchPersistentContext(this.profileDir, launchOptions);
    this.context = context;
    if (this.stopping) {
      await context.close();
      this.context = undefined;
      throw new Error("Browser provider stopped during startup");
    }

    const pages = context.pages();
    const startupPage = pages[0] ?? await context.newPage();
    this.observePage(startupPage);
    this.dashboardPage = startupPage;
    await this.openDashboard(startupPage);
    for (const page of context.pages()) if (page !== startupPage) this.observePage(page);
    await this.keepDashboardForeground();
  }

  private async openDashboard(page: Page): Promise<void> {
    const maxAttempts = 20;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (this.stopping) throw new Error("Browser provider is stopping");
      try {
        if (page.url() !== DASHBOARD_URL) {
          await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: 3000 });
        }
        return;
      } catch (error) {
        if (attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  private async keepDashboardForeground(): Promise<void> {
    const dashboard = this.dashboardPage;
    if (!dashboard || dashboard.isClosed() || this.headless || this.stopping) return;
    try { await dashboard.bringToFront(); } catch { /* browser may be shutting down */ }
  }

  private async initializeAgent(agent: ManagedAgent): Promise<void> {
    try {
      if (this.stopping) throw new Error("Browser provider is stopping");
      if (agent.page.isClosed()) throw new Error("Agent browser page is closed");
      this.patch(agent, { status: "opening-chatgpt", lastError: "" });
      await this.keepDashboardForeground();

      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(agent.page.url())) {
        await agent.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      }
      await this.keepDashboardForeground();
      await this.waitForComposerOrLogin(agent.page, 30000);
      await this.keepDashboardForeground();
      if (!await this.isAuthenticated(agent.page)) {
        this.patch(agent, { status: "login-required", lastError: "请在托管的 Chromium 中完成 ChatGPT 登录，然后点击继续。" });
        return;
      }
      this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
      if (agent.prompt) {
        const prompt = agent.prompt;
        delete agent.prompt;
        await this.send(agent, prompt);
      }
    } catch (error) {
      if (!this.stopping) this.patch(agent, { status: "failed", lastError: error instanceof Error ? error.message : String(error) });
    } finally {
      await this.keepDashboardForeground();
    }
  }

  private async send(agent: ManagedAgent, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Message cannot be empty");
    await this.ensurePageReady(agent);
    if (!await this.isAuthenticated(agent.page)) {
      this.patch(agent, { status: "login-required", lastError: "ChatGPT 登录态不可用" });
      throw new Error("ChatGPT is not logged in");
    }

    await this.waitForTurnIdle(agent.page);
    const previous = await this.latestAssistant(agent.page);
    this.patch(agent, { status: "sending", lastError: "" });
    await this.keepDashboardForeground();
    this.emit({ type: "agent.message", agentId: agent.id, role: "user", text, url: agent.page.url() });
    await this.fillComposer(agent.page, text);
    await this.keepDashboardForeground();
    this.patch(agent, { status: "waiting", conversationUrl: agent.page.url() });

    const response = await this.waitForAssistant(agent.page, previous);
    await this.waitForTurnIdle(agent.page);
    this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text: response, url: agent.page.url() });
    this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
  }

  private async ensurePageReady(agent: ManagedAgent): Promise<void> {
    if (this.stopping) throw new Error("Browser provider is stopping");
    if (agent.page.isClosed()) throw new Error("Agent browser page is closed");
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(agent.page.url())) {
      await agent.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      await this.keepDashboardForeground();
    }
    await this.waitForComposerOrLogin(agent.page, 30000);
  }

  private async waitForComposerOrLogin(page: Page, timeoutMs: number): Promise<void> {
    await page.waitForFunction(() => {
      const body = document.body?.innerText ?? "";
      const composer = document.querySelector("[contenteditable='true'], textarea, [role='textbox']");
      return Boolean(composer) || /log in|sign in|登录|注册/i.test(body) || /\/auth\//i.test(location.pathname);
    }, undefined, { timeout: timeoutMs });
  }

  private async isAuthenticated(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      const path = location.pathname;
      if (/\/auth\//i.test(path) || /\/login/i.test(path)) return false;
      return Boolean(document.querySelector("[contenteditable='true'], textarea, [role='textbox']"));
    });
  }

  private async waitForTurnIdle(page: Page): Promise<void> {
    await page.waitForFunction(() => {
      const stopButton = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop generating" i], button[aria-label*="停止" i]');
      if (stopButton) return false;
      const composer = document.querySelector<HTMLElement>("[contenteditable='true'], textarea, [role='textbox']");
      if (!composer) return false;
      const disabled = composer instanceof HTMLInputElement || composer instanceof HTMLTextAreaElement
        ? composer.disabled
        : composer.getAttribute("aria-disabled") === "true" || composer.getAttribute("contenteditable") === "false";
      return !disabled;
    }, undefined, { timeout: TURN_IDLE_TIMEOUT_MS });
  }

  private async fillComposer(page: Page, text: string): Promise<void> {
    const composer = page.locator("[contenteditable='true'], textarea, [role='textbox']").first();
    await composer.waitFor({ state: "visible", timeout: 15000 });
    await composer.fill(text);
    await page.waitForTimeout(300);
    const sendButton = page.locator('button[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="发送" i], button[type="submit"]').first();
    if (await sendButton.isVisible().catch(() => false)) {
      const disabled = await sendButton.isDisabled().catch(() => false);
      if (!disabled) {
        await sendButton.click();
        return;
      }
    }
    await composer.press("Enter");
  }

  private async latestAssistant(page: Page): Promise<AssistantSnapshot> {
    return page.evaluate(() => {
      const selectors = [
        "[data-message-author-role='assistant']",
        "article[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
        "[data-testid^='conversation-turn'] [data-message-author-role='assistant']",
      ];
      const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll<HTMLElement>(selector)));
      const unique = [...new Set(nodes)];
      const texts = unique.map((node) => node.innerText.trim()).filter(Boolean);
      return { text: texts.at(-1) ?? "", count: texts.length };
    });
  }

  private async waitForAssistant(page: Page, previous: AssistantSnapshot): Promise<string> {
    const started = Date.now();
    let last = "";
    let stableSince = 0;

    while (Date.now() - started < RESPONSE_TIMEOUT_MS) {
      const current = await this.latestAssistant(page);
      const changed = current.count > previous.count || (current.text.length > 0 && current.text !== previous.text);
      if (changed && current.text) {
        if (current.text !== last) {
          last = current.text;
          stableSince = Date.now();
        }
        if (Date.now() - stableSince >= STABILITY_MS) return current.text;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("Timed out waiting for ChatGPT response after 120s");
  }

  private observePage(page: Page): void {
    page.on("close", () => {
      if (this.dashboardPage === page) this.dashboardPage = undefined;
      for (const agent of this.agents.values()) if (agent.page === page) {
        this.patch(agent, { status: "tab-closed", lastError: "浏览器页面已关闭" });
      }
    });
  }

  private patch(agent: ManagedAgent, patch: Partial<BrowserAgent>): void {
    Object.assign(agent, patch, { updatedAt: Date.now() });
    this.emit({ type: "agent.updated", agent: this.publicAgent(agent) });
    if (patch.status) this.emit({ type: "agent.state", agentId: agent.id, state: patch.status, url: agent.page.url() });
  }

  private publicAgent(agent: ManagedAgent): BrowserAgent {
    const { page: _page, ...publicAgent } = agent;
    return publicAgent;
  }

  private emit(event: BrowserAgentEvent): void { if (this.onEvent) this.onEvent(event); }
}
