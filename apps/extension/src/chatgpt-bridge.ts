type ToolCall = { tool: string; arguments: Record<string, unknown> };
type ToolResult = { ok: boolean; result?: unknown; error?: string };

type RuntimeResponse = { result?: unknown; error?: { message?: string } };

const PANEL_ID = "bca-chatgpt-bridge";
const WORKSPACE_KEY = "bca.workspace";
const MAX_ROUNDS = 12;

let running = false;

function runtimeRpc(message: Record<string, unknown>): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: RuntimeResponse | undefined) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      if (!response) { reject(new Error("Extension returned no response")); return; }
      resolve(response);
    });
  });
}

function getComposer(): HTMLTextAreaElement | HTMLElement | null {
  return document.querySelector<HTMLTextAreaElement>("textarea")
    ?? document.querySelector<HTMLElement>("[contenteditable='true']");
}

function setComposerValue(composer: HTMLTextAreaElement | HTMLElement, text: string): void {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(composer, text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  composer.textContent = text;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

async function submitToChatGPT(text: string): Promise<void> {
  const composer = getComposer();
  if (!composer) throw new Error("ChatGPT composer was not found. Open a normal ChatGPT conversation.");
  setComposerValue(composer, text);
  await new Promise((resolve) => setTimeout(resolve, 100));
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function assistantArticles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("article")).filter((node) => node.innerText.trim().length > 0);
}

async function waitForAssistantResponse(previousCount: number): Promise<string> {
  const started = Date.now();
  let stableText = "";
  let stableSince = 0;
  while (Date.now() - started < 120000) {
    const articles = assistantArticles();
    if (articles.length > previousCount) {
      const text = articles.at(-1)?.innerText.trim() ?? "";
      if (text && text !== stableText) { stableText = text; stableSince = Date.now(); }
      if (stableText && Date.now() - stableSince > 900) return stableText;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for ChatGPT response");
}

function parseToolPlan(text: string): { calls: ToolCall[]; done: boolean } {
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const candidates = [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0] ?? ""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as unknown;
      if (!value || typeof value !== "object") continue;
      const record = value as { calls?: unknown; done?: unknown };
      if (!Array.isArray(record.calls)) continue;
      const calls = record.calls.map((item, index) => {
        if (!item || typeof item !== "object") throw new Error(`Invalid tool call ${index + 1}`);
        const call = item as { tool?: unknown; arguments?: unknown };
        if (typeof call.tool !== "string") throw new Error(`Tool call ${index + 1} has no tool name`);
        if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error(`Arguments for ${call.tool} must be an object`);
        return { tool: call.tool, arguments: call.arguments as Record<string, unknown> };
      });
      return { calls, done: record.done === true || calls.length === 0 };
    } catch { /* try next candidate */ }
  }
  throw new Error("ChatGPT did not return the required JSON tool plan");
}

function plannerPrompt(goal: string, tools: unknown[], history: unknown[]): string {
  return [
    "You are the brain of Browser Coding Agent. You are operating inside the user's logged-in ChatGPT browser session.",
    "The local computer is controlled only through the tools listed below. Never claim a local change was made unless a tool result confirms it.",
    "Plan only the NEXT batch of tool calls. After receiving tool results, decide the next batch. If a command fails, diagnose it and repair it instead of repeating the same failed call.",
    "Return JSON ONLY. No markdown, no explanation.",
    'When work is complete, return {"done":true,"calls":[]}. Otherwise return {"done":false,"calls":[{"tool":"...","arguments":{}}]}.',
    `Goal: ${goal}`,
    `Available tools: ${JSON.stringify(tools)}`,
    `Execution history: ${JSON.stringify(history)}`,
  ].join("\n\n");
}

async function runAgent(goal: string, workspace: string, status: HTMLElement): Promise<void> {
  if (running) return;
  running = true;
  try {
    const selected = await runtimeRpc({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "workspace.select", params: { path: workspace } });
    if (selected.error) throw new Error(selected.error.message ?? "Workspace selection failed");
    const toolsResponse = await runtimeRpc({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools.list" });
    if (toolsResponse.error) throw new Error(toolsResponse.error.message ?? "Unable to list tools");
    const tools = toolsResponse.result ?? [];
    const history: Array<{ call: ToolCall; result: ToolResult }> = [];
    status.textContent = "已连接本地 Runtime，正在让 ChatGPT 规划…";
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const articlesBefore = assistantArticles().length;
      await submitToChatGPT(plannerPrompt(goal, tools, history));
      const responseText = await waitForAssistantResponse(articlesBefore);
      const plan = parseToolPlan(responseText);
      if (plan.done) { status.textContent = "Agent 已完成"; return; }
      for (const call of plan.calls) {
        status.textContent = `执行 ${call.tool}…`;
        const response = await runtimeRpc({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tool.call", params: { call } });
        const result = response.error ? { ok: false, error: response.error.message ?? "Runtime tool call failed" } : response.result as ToolResult;
        history.push({ call, result });
        status.textContent = result.ok ? `完成 ${call.tool}，返回 ChatGPT 分析…` : `${call.tool} 失败，返回 ChatGPT 修复…`;
      }
    }
    throw new Error(`Agent stopped after ${MAX_ROUNDS} planning rounds`);
  } finally { running = false; }
}

function mountPanel(): void {
  if (document.getElementById(PANEL_ID)) return;
  const panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;padding:14px;border:1px solid #d1d5db;border-radius:12px;background:#fff;color:#111827;box-shadow:0 12px 40px rgba(0,0,0,.18);font:13px system-ui,sans-serif";
  panel.innerHTML = `<strong>Browser Coding Agent</strong><div style="margin-top:8px"><input id="bca-workspace" placeholder="本地工作区，例如 E:\\web\\project" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px"></div><div style="margin-top:8px"><textarea id="bca-goal" placeholder="告诉 ChatGPT 你要开发什么…" rows="4" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #d1d5db;border-radius:8px;resize:vertical"></textarea></div><button id="bca-start" style="margin-top:8px;width:100%;padding:8px;border:0;border-radius:8px;background:#111827;color:#fff;cursor:pointer">开始 Agent</button><div id="bca-status" style="margin-top:8px;color:#4b5563">等待任务…</div>`;
  document.body.append(panel);
  const workspaceInput = panel.querySelector<HTMLInputElement>("#bca-workspace")!;
  const goalInput = panel.querySelector<HTMLTextAreaElement>("#bca-goal")!;
  const button = panel.querySelector<HTMLButtonElement>("#bca-start")!;
  const status = panel.querySelector<HTMLDivElement>("#bca-status")!;
  chrome.storage.local.get(WORKSPACE_KEY, (value) => { if (typeof value[WORKSPACE_KEY] === "string") workspaceInput.value = value[WORKSPACE_KEY] as string; });
  button.addEventListener("click", () => {
    const workspace = workspaceInput.value.trim(); const goal = goalInput.value.trim();
    if (!workspace || !goal) { status.textContent = "请填写工作区和任务"; return; }
    chrome.storage.local.set({ [WORKSPACE_KEY]: workspace }); button.disabled = true;
    void runAgent(goal, workspace, status).catch((error: unknown) => { status.textContent = `Agent 失败：${error instanceof Error ? error.message : String(error)}`; }).finally(() => { button.disabled = false; });
  });
}

if (location.hostname === "chatgpt.com" || location.hostname === "chat.openai.com") {
  const boot = () => mountPanel();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true }); else boot();
  new MutationObserver(() => { if (!document.getElementById(PANEL_ID)) mountPanel(); }).observe(document.documentElement, { childList: true, subtree: true });
}

export {};
