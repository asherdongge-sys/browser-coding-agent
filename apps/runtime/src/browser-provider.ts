export type BrowserProviderKind = "extension" | "playwright";

export type BrowserAgentMessage = {
  role: "user" | "assistant";
  text: string;
  createdAt: number;
};

export type BrowserToolName = "browser.navigate" | "browser.search" | "browser.click" | "browser.type" | "browser.press" | "browser.scroll" | "browser.read_page" | "browser.extract" | "browser.wait";

export type BrowserToolCall = {
  tool: BrowserToolName;
  arguments: Record<string, unknown>;
};

export type BrowserToolResult = {
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type BrowserAgent = {
  id: string;
  title: string;
  prompt?: string;
  status: string;
  conversationUrl?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
  messages?: BrowserAgentMessage[];
};

export type BrowserAgentEvent =
  | { type: "agent.created"; agent: BrowserAgent }
  | { type: "agent.updated"; agent: BrowserAgent }
  | { type: "agent.message"; agentId: string; role: "user" | "assistant"; text: string; url?: string; createdAt?: number; streaming?: boolean }
  | { type: "agent.state"; agentId: string; state: string; url?: string }
  | { type: "agent.tool.call"; agentId: string; call: BrowserToolCall }
  | { type: "agent.tool.result"; agentId: string; call: BrowserToolCall; result: BrowserToolResult };

export type BrowserProvider = {
  readonly kind: BrowserProviderKind;
  start(): Promise<void>;
  listAgents(): Promise<BrowserAgent[]>;
  createAgent(title: string, prompt: string): Promise<BrowserAgent>;
  sendMessage(agentId: string, text: string): Promise<void>;
  resumeAgent(agentId: string): Promise<BrowserAgent>;
  runTask(agentId: string, goal: string): Promise<void>;
  stop(): Promise<void>;
};
