type AgentEvent = { type: "state.changed" | "tool.call" | "tool.result"; state?: string; call?: { tool: string; arguments: unknown }; result?: { ok: boolean; error?: string; result?: unknown } };
const connection = document.querySelector<HTMLDivElement>("#connection")!;
const workspaceInput = document.querySelector<HTMLInputElement>("#workspace")!;
const goal = document.querySelector<HTMLTextAreaElement>("#goal")!;
const run = document.querySelector<HTMLButtonElement>("#run")!;
const bridgeTest = document.querySelector<HTMLButtonElement>("#bridge-test")!;
const dashboardButton = document.querySelector<HTMLButtonElement>("#agent-dashboard")!;
const diagnostic = document.querySelector<HTMLDivElement>("#diagnostic")!;
const events = document.querySelector<HTMLDivElement>("#events")!;

function addEvent(text: string, state?: string): void {
  if (events.children.length === 1 && events.textContent === "等待任务…") events.innerHTML = "";
  const item = document.createElement("div"); item.className = "event";
  if (state) { const badge = document.createElement("span"); badge.className = "state"; badge.textContent = state; item.append(badge, document.createTextNode(` ${text}`)); }
  else item.textContent = text;
  events.prepend(item);
}
function updateConnection(): void { connection.textContent = "Runtime 按需连接；启动 Agent 时自动连接"; }
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

async function runBridgeDiagnostic(): Promise<void> {
  bridgeTest.disabled = true; diagnostic.textContent = "正在检查当前 ChatGPT 页面…"; addEvent("开始 Bridge 诊断", "bridge-diagnostic");
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string; diagnostic?: { composer: boolean; composerTag: string | null; sendButton: boolean; assistantCount: number; latestAssistantTextLength: number; url: string } }>({ type: "chatgpt.bridge.diagnostic" });
    if (!response.ok || !response.diagnostic) { diagnostic.textContent = `失败：${response.error ?? "没有诊断结果"}`; addEvent(`Bridge 诊断失败：${response.error ?? "unknown error"}`); return; }
    const d = response.diagnostic;
    diagnostic.textContent = [
      `Composer: ${d.composer ? "✅" : "❌"} ${d.composerTag ?? ""}`,
      `Send button: ${d.sendButton ? "✅" : "❌"}`,
      `Assistant count: ${d.assistantCount}`,
      `Latest assistant text: ${d.latestAssistantTextLength} chars`,
      `URL: ${d.url}`,
    ].join("\n");
    addEvent("Bridge DOM 诊断完成");
  } catch (error) { diagnostic.textContent = `失败：${error instanceof Error ? error.message : String(error)}`; addEvent(`Bridge 诊断请求失败：${error instanceof Error ? error.message : String(error)}`); }
  finally { bridgeTest.disabled = false; }
}

async function runBridgeTest(): Promise<void> {
  bridgeTest.disabled = true; run.disabled = true; diagnostic.textContent = "正在发送最小测试…"; addEvent("发送 BROWSER_AGENT_BRIDGE_OK 测试", "bridge-test");
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string }>({ type: "chatgpt.bridge.test" });
    if (!response.ok) { diagnostic.textContent = `失败：${response.error ?? "unknown error"}`; addEvent(`Bridge 测试启动失败：${response.error ?? "unknown error"}`); }
    else { diagnostic.textContent = "测试已发送。请看 Agent 活动中的 bridge-test-passed / bridge-test-failed。"; addEvent("Bridge 测试已启动"); }
  } catch (error) { diagnostic.textContent = `失败：${error instanceof Error ? error.message : String(error)}`; addEvent(`Bridge 测试请求失败：${error instanceof Error ? error.message : String(error)}`); }
  finally { bridgeTest.disabled = false; run.disabled = false; }
}

async function startAgent(): Promise<void> {
  const path = workspaceInput.value.trim(); const text = goal.value.trim();
  if (!path) { workspaceInput.focus(); addEvent("请先填写工作区路径"); return; }
  if (!text) { goal.focus(); addEvent("请先填写任务"); return; }
  run.disabled = true; addEvent(`任务：${text}`); await chrome.storage.local.set({ workspacePath: path });
  try {
    const response = await sendMessage<{ ok?: boolean; error?: string }>({ type: "chatgpt.start", workspace: path, goal: text });
    if (!response.ok) addEvent(`启动失败：${response.error ?? "unknown error"}`); else addEvent("已发送到当前 ChatGPT 页面，Agent 开始工作");
  } catch (error) { addEvent(`请求失败：${error instanceof Error ? error.message : String(error)}`); }
  finally { run.disabled = false; }
}

chrome.runtime.onMessage.addListener((message: { type?: string; params?: AgentEvent }) => {
  if (message?.type !== "agent.event" || !message.params) return;
  const event = message.params;
  if (event.type === "state.changed") addEvent("状态变化", event.state);
  else if (event.type === "tool.call") addEvent(`调用 ${event.call?.tool ?? "tool"}`);
  else if (event.type === "tool.result") {
    const result = event.result;
    if (result?.ok) {
      const value = typeof result.result === "object" && result.result !== null ? JSON.stringify(result.result) : String(result?.result ?? "");
      addEvent(`完成 ${event.call?.tool ?? "Bridge"}${value ? `：${value.slice(0, 500)}` : ""}`);
      if (value.includes("BROWSER_AGENT_BRIDGE_OK")) diagnostic.textContent = "✅ ChatGPT Bridge 往返测试成功：BROWSER_AGENT_BRIDGE_OK";
    } else addEvent(`失败：${result?.error ?? "unknown error"}`);
  }
});

chrome.storage.local.get(["workspacePath"], (result) => { if (typeof result.workspacePath === "string") workspaceInput.value = result.workspacePath; });
workspaceInput.addEventListener("change", () => { void chrome.storage.local.set({ workspacePath: workspaceInput.value.trim() }); });
run.addEventListener("click", () => { void startAgent(); });
bridgeTest.addEventListener("click", () => { void runBridgeTest(); });
dashboardButton.addEventListener("click", () => { void sendMessage({ type: "agent.dashboard.open" }); });
goal.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void startAgent(); });
updateConnection();

export {};
