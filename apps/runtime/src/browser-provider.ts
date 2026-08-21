export type BrowserProviderKind = "extension" | "playwright";

export type BrowserAgent = {
  id: string;
  title: string;
  prompt?: string;
  status: string;
  conversationUrl?: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};

export type BrowserAgentEvent =
  | { type: "agent.created"; agent: BrowserAgent }
  | { type: "agent.updated"; agent: BrowserAgent }
  | { type: "agent.message"; agentId: string; role: "user" | "assistant"; text: string; url?: string }
  | { type: "agent.state"; agentId: string; state: string; url?: string };

export type BrowserProvider = {
  readonly kind: BrowserProviderKind;
  start(): Promise<void>;
  listAgents(): Promise<BrowserAgent[]>;
  createAgent(title: string, prompt: string): Promise<BrowserAgent>;
  sendMessage(agentId: string, text: string): Promise<void>;
  resumeAgent(agentId: string): Promise<BrowserAgent>;
  stop(): Promise<void>;
};
