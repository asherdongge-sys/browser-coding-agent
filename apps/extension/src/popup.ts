type AgentEvent = { type: "state.changed" | "tool.call" | "tool.result"; state?: string; call?: { tool: string; arguments: unknown }; result?: { ok: boolean; error?: string; result?: unknown } };
const connection = document.querySelector<HTMLDivElement>("#connection")!;
const workspaceInput = document.querySelector<HTMLInputElement>("#workspace")!;
const goal = document.querySelector<HTMLTextAreaElement>("#goal")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const events = document.querySelector<HTMLDivElement>("#events")!;
let socket: WebSocket | undefined;
function addEvent(text: string, state?: string): void { if (events.children.length === 1 && events.textContent === "等待任务…") events.innerHTML = ""; const item = document.createElement("div"); item.className = "event"; if (state) { const badge = document.createElement("span"); badge.className = "state"; badge.textContent = state; item.append(badge, document.createTextNode(` ${text}`)); } else item.textContent = text; events.prepend(item); }
function connectEvents(): void {
  socket = new WebSocket("ws://127.0.0.1:4317");
  socket.addEventListener("open", () => { connection.textContent = "Runtime 已连接"; });
  socket.addEventListener("message", (event) => {
    let message: unknown; try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message || typeof message !== "object") return;
    const data = message as { method?: string; params?: AgentEvent };
    if (data.method !== "agent.event" || !data.params) return;
    const e = data.params;
    if (e.type === "state.changed") addEvent("状态变化", e.state);
    else if (e.type === "tool.call") addEvent(`调用 ${e.call?.tool ?? "tool"}`);
    else if (e.type === "tool.result") addEvent(e.result?.ok ? `完成 ${e.call?.tool ?? "tool"}` : `失败：${e.result?.error ?? "unknown error"}`);
  });
  socket.addEventListener("close", () => { connection.textContent = "Runtime 已断开"; });
}
async function selectWorkspace(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "workspace.select", params: { path } }, (response) => {
      if (chrome.runtime.lastError) { addEvent(`工作区选择失败：${chrome.runtime.lastError.message}`); resolve(false); return; }
      if (response?.error) { addEvent(`工作区选择失败：${response.error.message ?? "unknown error"}`); resolve(false); return; }
      addEvent(`工作区已选择：${response?.result?.root ?? path}`); resolve(true);
    });
  });
}
async function startAgent(): Promise<void> {
  const path = workspaceInput.value.trim(); const text = goal.value.trim();
  if (!path) { workspaceInput.focus(); addEvent("请先填写工作区路径"); return; }
  if (!text) { goal.focus(); return; }
  run.disabled = true; addEvent(`任务：${text}`);
  if (!(await selectWorkspace(path))) { run.disabled = false; return; }
  chrome.runtime.sendMessage({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "agent.run", params: { goal: text } }, (response) => {
    run.disabled = false;
    if (chrome.runtime.lastError) addEvent(`请求失败：${chrome.runtime.lastError.message}`);
    else if (response?.error) addEvent(`Agent 失败：${response.error.message ?? "unknown error"}`);
    else addEvent(`Agent 已结束：${response?.result?.state ?? "unknown"}`);
  });
}
chrome.storage.local.get(["workspacePath"], (result) => { if (typeof result.workspacePath === "string") workspaceInput.value = result.workspacePath; });
workspaceInput.addEventListener("change", () => { void chrome.storage.local.set({ workspacePath: workspaceInput.value.trim() }); });
run.addEventListener("click", () => { void startAgent(); });
goal.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void startAgent(); });
connectEvents();

export {};
