type DashboardAgentRecord = {
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
type AgentMessage = { role: "user" | "assistant"; text: string; createdAt: number };
type AgentEvent = { type?: "agent.state" | "agent.message"; agentId?: string; state?: string; role?: "user" | "assistant"; text?: string };

const MESSAGES_KEY = "browser-coding-agent-messages";
const newAgentButton = document.querySelector<HTMLButtonElement>("#new-agent")!;
const agentsEl = document.querySelector<HTMLDivElement>("#agents")!;
const titleEl = document.querySelector<HTMLDivElement>("#title")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const resumeButton = document.querySelector<HTMLButtonElement>("#resume")!;
const messagesEl = document.querySelector<HTMLDivElement>("#messages")!;
const inputEl = document.querySelector<HTMLTextAreaElement>("#input")!;
const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
const openChatGpt = document.querySelector<HTMLButtonElement>("#open-chatgpt")!;
const modal = document.querySelector<HTMLDivElement>("#modal-backdrop")!;
const titleInput = document.querySelector<HTMLInputElement>("#agent-title-input")!;
const promptInput = document.querySelector<HTMLTextAreaElement>("#agent-prompt-input")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
const createButton = document.querySelector<HTMLButtonElement>("#create")!;

let agents: DashboardAgentRecord[] = [];
let selectedAgentId: string | null = null;
let messages: Record<string, AgentMessage[]> = {};

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: T | undefined) => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (response === undefined) { reject(new Error("Extension returned no response")); return; }
        resolve(response);
      });
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function load(): Promise<void> {
  const stored = await chrome.storage.local.get(MESSAGES_KEY);
  if (stored[MESSAGES_KEY] && typeof stored[MESSAGES_KEY] === "object") messages = stored[MESSAGES_KEY] as Record<string, AgentMessage[]>;
  const response = await sendMessage<{ ok?: boolean; agents?: DashboardAgentRecord[] }>({ type: "agent.list" });
  agents = response.agents ?? [];
  renderAgents();
  if (selectedAgentId && agents.some((agent) => agent.id === selectedAgentId)) selectAgent(selectedAgentId);
  else if (agents[0]) selectAgent(agents[0].id);
}

async function persistMessages(): Promise<void> { await chrome.storage.local.set({ [MESSAGES_KEY]: messages }); }

function statusText(agent: DashboardAgentRecord): string {
  const map: Record<string, string> = {
    "opening-chatgpt": "正在打开 ChatGPT", "login-required": "等待登录", sending: "正在发送", waiting: "等待 ChatGPT",
    idle: "空闲", failed: "失败", "tab-closed": "标签页已关闭",
  };
  return map[agent.status] ?? agent.status;
}

function renderAgents(): void {
  agentsEl.innerHTML = "";
  if (!agents.length) { const empty = document.createElement("div"); empty.className = "muted"; empty.textContent = "还没有 Agent"; agentsEl.append(empty); return; }
  for (const agent of agents) {
    const button = document.createElement("button"); button.className = `agent-item${agent.id === selectedAgentId ? " active" : ""}`;
    const title = document.createElement("div"); title.className = "agent-title"; title.textContent = agent.title;
    const state = document.createElement("div"); state.className = "agent-status"; state.textContent = statusText(agent);
    button.append(title, state); button.addEventListener("click", () => selectAgent(agent.id)); agentsEl.append(button);
  }
}

function renderMessages(): void {
  const agentMessages = selectedAgentId ? messages[selectedAgentId] ?? [] : [];
  messagesEl.innerHTML = "";
  if (!selectedAgentId || !agentMessages.length) {
    const empty = document.createElement("div"); empty.className = "empty";
    empty.textContent = selectedAgentId ? "这个 Agent 还没有消息。发送第一条指令开始对话。" : "新建 Agent 后输入任务。Agent 会自动打开独立的 ChatGPT 对话。";
    messagesEl.append(empty); return;
  }
  for (const message of agentMessages) { const item = document.createElement("div"); item.className = `message ${message.role}`; item.textContent = message.text; messagesEl.append(item); }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function selectAgent(id: string): void {
  selectedAgentId = id;
  const agent = agents.find((item) => item.id === id);
  if (!agent) return;
  titleEl.textContent = agent.title;
  statusEl.textContent = agent.lastError ? `${statusText(agent)} · ${agent.lastError}` : `${statusText(agent)}${agent.conversationUrl ? ` · ${agent.conversationUrl}` : ""}`;
  resumeButton.classList.toggle("hidden", agent.status !== "login-required");
  inputEl.disabled = agent.status === "opening-chatgpt" || agent.status === "login-required";
  sendButton.disabled = inputEl.disabled;
  renderAgents(); renderMessages();
}

function appendMessage(agentId: string, role: "user" | "assistant", text: string): void {
  const list = messages[agentId] ?? (messages[agentId] = []);
  if (list.at(-1)?.role === role && list.at(-1)?.text === text) return;
  list.push({ role, text, createdAt: Date.now() }); void persistMessages();
  if (selectedAgentId === agentId) renderMessages();
}

function showModal(): void { titleInput.value = ""; promptInput.value = ""; modal.classList.remove("hidden"); titleInput.focus(); }
function hideModal(): void { modal.classList.add("hidden"); }

async function createDashboardAgent(): Promise<void> {
  const title = titleInput.value.trim(); const prompt = promptInput.value.trim(); createButton.disabled = true;
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string; agent?: DashboardAgentRecord }>({ type: "agent.create", title, prompt });
    if (!response.ok || !response.agent) throw new Error(response.error ?? "创建 Agent 失败");
    const index = agents.findIndex((agent) => agent.id === response.agent!.id);
    if (index >= 0) agents[index] = response.agent; else agents.unshift(response.agent);
    selectedAgentId = response.agent.id; hideModal(); renderAgents(); selectAgent(response.agent.id);
  } catch (error) { statusEl.textContent = error instanceof Error ? error.message : String(error); }
  finally { createButton.disabled = false; }
}

async function resumeSelectedAgent(): Promise<void> {
  if (!selectedAgentId) return;
  resumeButton.disabled = true;
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string }>({ type: "agent.resume", agentId: selectedAgentId });
    if (!response.ok) throw new Error(response.error ?? "继续运行失败");
  } catch (error) {
    const agent = agents.find((item) => item.id === selectedAgentId);
    if (agent) { agent.status = "failed"; agent.lastError = error instanceof Error ? error.message : String(error); }
    if (selectedAgentId) selectAgent(selectedAgentId);
  } finally { resumeButton.disabled = false; }
}

async function sendCurrentMessage(): Promise<void> {
  const agentId = selectedAgentId; const text = inputEl.value.trim(); if (!agentId || !text) return;
  inputEl.value = ""; sendButton.disabled = true; appendMessage(agentId, "user", text);
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string }>({ type: "agent.send", agentId, text });
    if (!response.ok) throw new Error(response.error ?? "发送失败");
  } catch (error) {
    const agent = agents.find((item) => item.id === agentId);
    if (agent) { agent.status = "failed"; agent.lastError = error instanceof Error ? error.message : String(error); }
    renderAgents(); selectAgent(agentId);
  } finally { sendButton.disabled = false; }
}

chrome.runtime.onMessage.addListener((message: { type?: string; agent?: DashboardAgentRecord; params?: AgentEvent }) => {
  if (message.type === "agent.created" && message.agent) {
    if (!agents.some((agent) => agent.id === message.agent!.id)) agents.unshift(message.agent);
    renderAgents(); return;
  }
  if (message.type === "agent.updated" && message.agent) {
    const index = agents.findIndex((agent) => agent.id === message.agent!.id);
    if (index >= 0) agents[index] = message.agent; else agents.unshift(message.agent);
    if (selectedAgentId === message.agent.id) selectAgent(message.agent.id); else renderAgents(); return;
  }
  if (message.type !== "agent.event" || !message.params) return;
  const event = message.params;
  const agentId = event.agentId;
  if (!agentId) return;
  if (event.type === "agent.message" && event.role && event.text) appendMessage(agentId, event.role, event.text);
  if (event.type === "agent.state") {
    const agent = agents.find((item) => item.id === agentId);
    if (agent) { agent.status = event.state ?? agent.status; renderAgents(); if (selectedAgentId === agent.id) selectAgent(agent.id); }
  }
});

newAgentButton.addEventListener("click", showModal);
cancelButton.addEventListener("click", hideModal);
createButton.addEventListener("click", () => { void createDashboardAgent(); });
resumeButton.addEventListener("click", () => { void resumeSelectedAgent(); });
sendButton.addEventListener("click", () => { void sendCurrentMessage(); });
inputEl.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void sendCurrentMessage(); } });
openChatGpt.addEventListener("click", () => { void chrome.tabs.create({ url: "https://chatgpt.com/", active: true }); });

void load();
