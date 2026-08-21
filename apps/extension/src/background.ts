const RUNTIME_URL = "ws://127.0.0.1:4317";
const APPROVAL_URL = "approval.html";
const AGENT_DASHBOARD_URL = "agent.html";
const AGENTS_KEY = "browser-coding-agent-agents";

type ApprovalRequest = { requestId: string; tool: string; risk: "read" | "write" | "execute" | "git"; description: string; arguments: unknown };
type AgentRecord = {
  id: string;
  title: string;
  prompt?: string;
  tabId?: number;
  conversationUrl?: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  lastError?: string;
};
let socket: WebSocket | undefined;
let currentApproval: ApprovalRequest | undefined;
const pendingRpc = new Map<string, (response: unknown) => void>();
const log = (...args: unknown[]) => console.log("[BrowserCodingAgent]", ...args);

function broadcast(message: unknown): void {
  chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
}

async function getAgents(): Promise<AgentRecord[]> {
  const result = await chrome.storage.local.get(AGENTS_KEY);
  return Array.isArray(result[AGENTS_KEY]) ? result[AGENTS_KEY] as AgentRecord[] : [];
}

async function saveAgents(agents: AgentRecord[]): Promise<void> { await chrome.storage.local.set({ [AGENTS_KEY]: agents }); }

async function updateAgent(id: string, patch: Partial<AgentRecord>): Promise<AgentRecord | undefined> {
  const agents = await getAgents();
  const index = agents.findIndex((agent) => agent.id === id);
  if (index < 0) return undefined;

  const current = agents[index];
  if (!current) return undefined;

  const updated: AgentRecord = {
    ...current,
    ...patch,
    updatedAt: Date.now(),
  };
  agents[index] = updated;

  await saveAgents(agents);
  broadcast({ type: "agent.updated", agent: updated });
  return updated;
}

async function openApprovalWindow(): Promise<void> {
  if (!currentApproval) return;
  const url = chrome.runtime.getURL(`${APPROVAL_URL}?requestId=${encodeURIComponent(currentApproval.requestId)}`);
  const existing = await chrome.tabs.query({ url: `${chrome.runtime.getURL(APPROVAL_URL)}*` }).catch(() => []);
  if (existing[0]?.id !== undefined) { await chrome.tabs.update(existing[0].id, { active: true }); return; }
  await chrome.windows.create({ url, type: "popup", width: 440, height: 620 });
}

function connectRuntime(): WebSocket {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socket;
  const ws = new WebSocket(RUNTIME_URL);
  socket = ws;
  log("connecting runtime", RUNTIME_URL);
  ws.addEventListener("open", () => {
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
    log("runtime connected");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "runtime.ping" }));
  });
  ws.addEventListener("message", (event) => {
    let message: unknown;
    try { message = JSON.parse(String(event.data)); } catch (error) { log("invalid runtime message", error); return; }
    if (!message || typeof message !== "object") return;
    const data = message as { method?: string; params?: Partial<ApprovalRequest>; id?: string | number };
    if (data.id !== undefined && !data.method) {
      const resolve = pendingRpc.get(String(data.id));
      if (resolve) { pendingRpc.delete(String(data.id)); resolve(data); }
      return;
    }
    if (data.method === "approval.request" && data.params?.requestId && data.params.tool && data.params.risk && data.params.description) {
      currentApproval = { requestId: data.params.requestId, tool: data.params.tool, risk: data.params.risk, description: data.params.description, arguments: data.params.arguments };
      broadcast({ type: "approval.request", request: currentApproval });
      void openApprovalWindow();
      return;
    }
    if (data.method === "agent.event") broadcast({ type: "agent.event", params: data.params });
  });
  ws.addEventListener("close", () => {
    if (socket === ws) socket = undefined;
    for (const resolve of pendingRpc.values()) resolve({ ok: false, error: "Runtime WebSocket disconnected" });
    pendingRpc.clear();
    log("runtime disconnected");
  });
  ws.addEventListener("error", (event) => log("runtime socket error", event));
  return ws;
}

function sendToRuntime(message: Record<string, unknown>, sendResponse: (response: unknown) => void): void {
  const ws = connectRuntime();
  const id = typeof message.id === "string" || typeof message.id === "number" ? String(message.id) : crypto.randomUUID();
  message.id = id;
  const send = () => {
    if (ws.readyState !== WebSocket.OPEN) { sendResponse({ ok: false, error: "Runtime WebSocket is not open" }); return; }
    pendingRpc.set(id, sendResponse);
    ws.send(JSON.stringify(message));
  };
  if (ws.readyState === WebSocket.OPEN) send(); else ws.addEventListener("open", send, { once: true });
}

async function ensureBridge(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "agent.ping" });
    if (response?.ok) return;
  } catch { /* inject below */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["agent-bridge.js"] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const response = await chrome.tabs.sendMessage(tabId, { type: "agent.ping" });
  if (!response?.ok) throw new Error("Agent Bridge did not start");
}

async function waitForChatGptTab(tabId: number, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url ?? "";
      if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url) && tab.status === "complete") {
        await ensureBridge(tabId);
        return;
      }
    } catch { /* tab may still be opening */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for ChatGPT tab");
}

async function createAgent(title: string, prompt: string): Promise<AgentRecord> {
  const agent: AgentRecord = {
    id: crypto.randomUUID(), title: title.trim() || `Agent ${new Date().toLocaleTimeString()}`,
    prompt: prompt.trim(), status: "opening-chatgpt", createdAt: Date.now(), updatedAt: Date.now(),
  };
  const agents = await getAgents(); agents.unshift(agent); await saveAgents(agents); broadcast({ type: "agent.created", agent });
  const tab = await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
  if (!tab.id) throw new Error("Unable to create ChatGPT tab");
  await updateAgent(agent.id, { tabId: tab.id });
  try {
    await waitForChatGptTab(tab.id);
    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: "agent.snapshot" });
    const authenticated = Boolean(snapshot?.snapshot?.authenticated);
    if (!authenticated) {
      await updateAgent(agent.id, { status: "login-required", lastError: "请在打开的 ChatGPT 标签页完成登录，然后点击继续。" });
      return (await getAgents()).find((item) => item.id === agent.id)!;
    }
    const currentUrl = (await chrome.tabs.get(tab.id)).url;
    await updateAgent(agent.id, currentUrl ? { status: "idle", lastError: "", conversationUrl: currentUrl } : { status: "idle", lastError: "" });
    if (prompt.trim()) await sendAgentMessage(agent.id, prompt.trim());
    return (await getAgents()).find((item) => item.id === agent.id)!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateAgent(agent.id, { status: "failed", lastError: message });
    return (await getAgents()).find((item) => item.id === agent.id)!;
  }
}

async function sendAgentMessage(agentId: string, text: string): Promise<void> {
  const agents = await getAgents(); const agent = agents.find((item) => item.id === agentId);
  if (!agent?.tabId) throw new Error("Agent ChatGPT tab is not available");
  await ensureBridge(agent.tabId);
  const response = await chrome.tabs.sendMessage(agent.tabId, { type: "agent.send", agentId, text });
  if (!response?.ok) throw new Error(response?.error ?? "Agent Bridge rejected the message");
  const currentUrl = (await chrome.tabs.get(agent.tabId)).url;
  await updateAgent(agentId, currentUrl ? { status: "waiting", lastError: "", conversationUrl: currentUrl } : { status: "waiting", lastError: "" });
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const request = message as Record<string, unknown>;

  if (request.type === "agent.dashboard.open") {
    void chrome.tabs.create({ url: chrome.runtime.getURL(AGENT_DASHBOARD_URL), active: true }).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === "agent.list") { void getAgents().then((agents) => sendResponse({ ok: true, agents })); return true; }
  if (request.type === "agent.create") {
    const title = typeof request.title === "string" ? request.title : "";
    const prompt = typeof request.prompt === "string" ? request.prompt : "";
    void createAgent(title, prompt).then((agent) => sendResponse({ ok: true, agent })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === "agent.resume") {
    const agentId = typeof request.agentId === "string" ? request.agentId : "";
    void (async () => {
      const agents = await getAgents(); const agent = agents.find((item) => item.id === agentId);
      if (!agent?.tabId) throw new Error("Agent ChatGPT tab is not available");
      await waitForChatGptTab(agent.tabId);
      const snapshot = await chrome.tabs.sendMessage(agent.tabId, { type: "agent.snapshot" });
      if (!snapshot?.snapshot?.authenticated) throw new Error("ChatGPT is still not logged in");
      await updateAgent(agentId, { status: "idle", lastError: "" });
      if (agent.prompt) await sendAgentMessage(agentId, agent.prompt);
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === "agent.send") {
    const agentId = typeof request.agentId === "string" ? request.agentId : "";
    const text = typeof request.text === "string" ? request.text.trim() : "";
    if (!agentId || !text) { sendResponse({ ok: false, error: "agentId and text are required" }); return false; }
    void sendAgentMessage(agentId, text).then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === "agent.event") {
    const params = request.params as { agentId?: unknown; type?: string; url?: string; state?: string } | undefined;
    if (typeof params?.agentId === "string") {
      const patch: Partial<AgentRecord> = {};
      if (typeof params.state === "string") patch.status = params.state;
      if (typeof params.url === "string") patch.conversationUrl = params.url;
      void updateAgent(params.agentId, patch);
    }
    broadcast({ type: "agent.event", params: request.params });
    return false;
  }

  if (request.type === "chatgpt.start") {
    const workspace = typeof request.workspace === "string" ? request.workspace : "";
    const goal = typeof request.goal === "string" ? request.goal : "";
    if (!workspace || !goal) { sendResponse({ ok: false, error: "Workspace and goal are required" }); return false; }
    void getActiveChatGptTab().then((tabId) => {
      chrome.tabs.sendMessage(tabId, { type: "chatgpt.start", workspace, goal }, () => { void chrome.runtime.lastError; });
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === "chatgpt.bridge.diagnostic" || request.type === "chatgpt.bridge.test") {
    void getActiveChatGptTab().then((tabId) => {
      chrome.tabs.sendMessage(tabId, request, (response) => {
        if (chrome.runtime.lastError) { sendResponse({ ok: false, error: chrome.runtime.lastError.message }); return; }
        sendResponse(response ?? { ok: false, error: "Bridge returned no response" });
      });
    }).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (request.type === "approval.current") { sendResponse({ request: currentApproval }); return false; }
  if (request.type === "approval.respond") {
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    const decision = request.decision;
    if (!requestId || (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny")) { sendResponse({ ok: false, error: "Invalid approval response" }); return false; }
    sendToRuntime({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "approval.respond", params: { requestId, decision } }, sendResponse);
    if (currentApproval?.requestId === requestId) currentApproval = undefined;
    return true;
  }
  if ("jsonrpc" in request) { sendToRuntime(request, sendResponse); return true; }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "complete") return;
  void getAgents().then(async (agents) => {
    const agent = agents.find((item) => item.tabId === tabId);
    if (!agent) return;
    if (changeInfo.url) await updateAgent(agent.id, { conversationUrl: changeInfo.url });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getAgents().then(async (agents) => {
    const agent = agents.find((item) => item.tabId === tabId);
    if (agent) await updateAgent(agent.id, { status: "tab-closed" });
  });
});

async function ensureChatGptBridge(tabId: number): Promise<void> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "chatgpt.ping" });
    if (response?.ok) return;
  } catch { /* inject below */ }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt-bridge.js"] });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const response = await chrome.tabs.sendMessage(tabId, { type: "chatgpt.ping" });
  if (!response?.ok) throw new Error("ChatGPT Bridge did not start");
}

async function getActiveChatGptTab(): Promise<number> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) throw new Error("No active tab");
  const url = tab.url ?? "";
  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) throw new Error("Active tab is not ChatGPT");
  await ensureChatGptBridge(tab.id);
  return tab.id;
}

connectRuntime();
