type AgentEvent = { type: "state.changed" | "tool.call" | "tool.result"; state?: string; call?: { tool: string; arguments: unknown }; result?: { ok: boolean; error?: string; result?: unknown } };

const connection = document.querySelector<HTMLDivElement>("#connection")!;
const goal = document.querySelector<HTMLTextAreaElement>("#goal")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const events = document.querySelector<HTMLDivElement>("#events")!;

function addEvent(text: string, state?: string): void {
  if (events.children.length === 1 && events.textContent === "等待任务…") events.innerHTML = "";
  const item = document.createElement("div"); item.className = "event";
  if (state) { const badge = document.createElement("span"); badge.className = "state"; badge.textContent = state; item.append(badge, document.createTextNode(` ${text}`)); }
  else item.textContent = text;
  events.prepend(item);
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") return;
  const event = message as { type?: string; params?: AgentEvent };
  if (event.type === "agent.event" && event.params) {
    const e = event.params;
    if (e.type === "state.changed") addEvent("状态变化", e.state);
    else if (e.type === "tool.call") addEvent(`调用 ${e.call?.tool ?? "tool"}`);
    else if (e.type === "tool.result") addEvent(e.result?.ok ? `完成 ${e.call?.tool ?? "tool"}` : `失败：${e.result?.error ?? "unknown error"}`);
  }
});

function startAgent(): void {
  const text = goal.value.trim();
  if (!text) { goal.focus(); return; }
  run.disabled = true;
  addEvent(`任务：${text}`);
  chrome.runtime.sendMessage({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "agent.run", params: { goal: text } }, (response) => {
    run.disabled = false;
    if (chrome.runtime.lastError) addEvent(`请求失败：${chrome.runtime.lastError.message}`);
    else if (response?.error) addEvent(`Agent 失败：${response.error.message ?? "unknown error"}`);
    else addEvent(`Agent 已结束：${response?.result?.state ?? "completed"}`);
  });
}

run.addEventListener("click", startAgent);
goal.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") startAgent(); });
chrome.runtime.sendMessage({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "runtime.ping" }, (response) => {
  connection.textContent = response?.result?.ok ? "Runtime 已连接" : "Runtime 未连接";
});
