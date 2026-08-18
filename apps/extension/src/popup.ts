type AgentEvent = { type: "state.changed" | "tool.call" | "tool.result"; state?: string; call?: { tool: string; arguments: unknown }; result?: { ok: boolean; error?: string; result?: unknown } };
const connection = document.querySelector<HTMLDivElement>("#connection")!;
const workspaceInput = document.querySelector<HTMLInputElement>("#workspace")!;
const goal = document.querySelector<HTMLTextAreaElement>("#goal")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const events = document.querySelector<HTMLDivElement>("#events")!;

function addEvent(text: string, state?: string): void {
  if (events.children.length === 1 && events.textContent === "等待任务…") events.innerHTML = "";
  const item = document.createElement("div");
  item.className = "event";
  if (state) {
    const badge = document.createElement("span");
    badge.className = "state";
    badge.textContent = state;
    item.append(badge, document.createTextNode(` ${text}`));
  } else item.textContent = text;
  events.prepend(item);
}

function updateConnection(): void {
  connection.textContent = "Runtime 按需连接；启动 Agent 时自动连接";
}

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T | undefined) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (response === undefined) { reject(new Error("Extension returned no response")); return; }
      resolve(response);
    });
  });
}

async function startAgent(): Promise<void> {
  const path = workspaceInput.value.trim();
  const text = goal.value.trim();
  if (!path) { workspaceInput.focus(); addEvent("请先填写工作区路径"); return; }
  if (!text) { goal.focus(); addEvent("请先填写任务"); return; }

  run.disabled = true;
  addEvent(`任务：${text}`);
  await chrome.storage.local.set({ workspacePath: path });
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string }>({ type: "chatgpt.start", workspace: path, goal: text });
    if (!response.ok) addEvent(`启动失败：${response.error ?? "unknown error"}`);
    else addEvent("已发送到当前 ChatGPT 页面，Agent 开始工作");
  } catch (error) {
    addEvent(`请求失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    run.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message: { type?: string; params?: AgentEvent }) => {
  if (message?.type !== "agent.event" || !message.params) return;
  const event = message.params;
  if (event.type === "state.changed") addEvent("状态变化", event.state);
  else if (event.type === "tool.call") addEvent(`调用 ${event.call?.tool ?? "tool"}`);
  else if (event.type === "tool.result") addEvent(event.result?.ok ? `完成 ${event.call?.tool ?? "tool"}` : `失败：${event.result?.error ?? "unknown error"}`);
});

chrome.storage.local.get(["workspacePath"], (result) => {
  if (typeof result.workspacePath === "string") workspaceInput.value = result.workspacePath;
});
workspaceInput.addEventListener("change", () => { void chrome.storage.local.set({ workspacePath: workspaceInput.value.trim() }); });
run.addEventListener("click", () => { void startAgent(); });
goal.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void startAgent(); });
updateConnection();

export {};
