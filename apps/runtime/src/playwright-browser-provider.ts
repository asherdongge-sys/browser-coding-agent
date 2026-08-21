import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserAgent, BrowserAgentEvent, BrowserProvider } from "./browser-provider.js";

const CHATGPT_URL = "https://chatgpt.com/";
const RESPONSE_TIMEOUT_MS = 120000;
const STABILITY_MS = 1000;

export type PlaywrightBrowserProviderOptions = {
  profileDir?: string;
  headless?: boolean;
  onEvent?: (event: BrowserAgentEvent) => void;
};

type ManagedAgent = BrowserAgent & { page: Page };

export class PlaywrightBrowserProvider implements BrowserProvider {
  readonly kind = "playwright" as const;
  private context: BrowserContext | undefined;
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly onEvent?: (event: BrowserAgentEvent) => void;

  constructor(options: PlaywrightBrowserProviderOptions = {}) {
    this.profileDir = options.profileDir ?? process.env.BROWSER_CODING_AGENT_PROFILE ?? ".browser-coding-agent/chromium";
    this.headless = options.headless ?? process.env.BROWSER_CODING_AGENT_HEADLESS === "1";
    this.onEvent = options.onEvent;
  }

  async start(): Promise<void> {
    if (this.context) return;
    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.headless,
      viewport: { width: 1440, height: 900 },
      userAgent: process.env.BROWSER_CODING_AGENT_USER_AGENT,
    });
    for (const page of this.context.pages()) this.observePage(page);
  }

  async listAgents(): Promise<BrowserAgent[]> {
    return [...this.agents.values()].map(({ page: _page, ...agent }) => agent);
  }

  async createAgent(title: string, prompt: string): Promise<BrowserAgent> {
    await this.start();
    const page = await this.context!.newPage();
    const agent: ManagedAgent = {
      id: crypto.randomUUID(),
      title: title.trim() || `Agent ${new Date().toLocaleTimeString()}`,
      prompt: prompt.trim() || undefined,
      status: "opening-chatgpt",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      page,
    };
    this.agents.set(agent.id, agent);
    this.emit({ type: "agent.created", agent: this.publicAgent(agent) });
    void this.initializeAgent(agent);
    return this.publicAgent(agent);
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
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

  async stop(): Promise<void> {
    if (!this.context) return;
    await this.context.close();
    this.context = undefined;
    this.agents.clear();
  }

  private async initializeAgent(agent: ManagedAgent): Promise<void> {
    try {
      await agent.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
      await this.waitForComposerOrLogin(agent.page, 30000);
      if (!await this.isAuthenticated(agent.page)) {
        this.patch(agent, { status: "login-required", lastError: "请在托管的 Chromium 中完成 ChatGPT 登录，然后点击继续。" });
        return;
      }
      this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
      if (agent.prompt) {
        const prompt = agent.prompt;
        agent.prompt = undefined;
        await this.send(agent, prompt);
      }
    } catch (error) {
      this.patch(agent, { status: "failed", lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private async send(agent: ManagedAgent, text: string): Promise<void> {
    if (!text.trim()) throw new Error("Message cannot be empty");
    await this.ensurePageReady(agent);
    if (!await this.isAuthenticated(agent.page)) {
      this.patch(agent, { status: "login-required", lastError: "ChatGPT 登录态不可用" });
      throw new Error("ChatGPT is not logged in");
    }
    const previous = await this.latestAssistant(agent.page);
    this.patch(agent, { status: "sending", lastError: "" });
    this.emit({ type: "agent.message", agentId: agent.id, role: "user", text, url: agent.page.url() });
    await this.fillComposer(agent.page, text);
    this.patch(agent, { status: "waiting", conversationUrl: agent.page.url() });
    const response = await this.waitForAssistant(agent.page, previous);
    this.emit({ type: "agent.message", agentId: agent.id, role: "assistant", text: response, url: agent.page.url() });
    this.patch(agent, { status: "idle", conversationUrl: agent.page.url(), lastError: "" });
  }

  private async ensurePageReady(agent: ManagedAgent): Promise<void> {
    if (agent.page.isClosed()) throw new Error("Agent browser page is closed");
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(agent.page.url())) {
      await agent.page.goto(CHATGPT_URL, { waitUntil: "domcontentloaded" });
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

  private async fillComposer(page: Page, text: string): Promise<void> {
    const composer = page.locator("[contenteditable='true'], textarea, [role='textbox']").filter({ visible: true }).first();
    await composer.waitFor({ state: "visible", timeout: 15000 });
    await composer.fill(text);
    await page.waitForTimeout(300);
    const sendButton = page.locator('button[data-testid="send-button"], button[aria-label*="Send" i], button[type="submit"]').filter({ visible: true }).first();
    if (await sendButton.count()) {
      await sendButton.click();
      return;
    }
    await composer.press("Enter");
  }

  private async latestAssistant(page: Page): Promise<{ text: string; count: number }> {
    return page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='assistant'], article"));
      const texts = nodes.map((node) => node.innerText.trim()).filter(Boolean);
      return { text: texts.at(-1) ?? "", count: texts.length };
    });
  }

  private async waitForAssistant(page: Page, previous: { text: string; count: number }): Promise<string> {
    const started = Date.now();
    let last = "";
    let stableSince = 0;
    while (Date.now() - started < RESPONSE_TIMEOUT_MS) {
      const current = await this.latestAssistant(page);
      const changed = current.count > previous.count || current.text.length > previous.text.length;
      if (changed && current.text) {
        if (current.text !== last) { last = current.text; stableSince = Date.now(); }
        if (Date.now() - stableSince >= STABILITY_MS) return current.text;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("Timed out waiting for ChatGPT response after 120s");
  }

  private observePage(page: Page): void {
    page.on("close", () => {
      for (const agent of this.agents.values()) {
        if (agent.page === page) this.patch(agent, { status: "tab-closed", lastError: "浏览器页面已关闭" });
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

  private emit(event: BrowserAgentEvent): void { this.onEvent?.(event); }
}
