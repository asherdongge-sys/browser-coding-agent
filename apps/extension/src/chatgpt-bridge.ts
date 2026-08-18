type ToolCall = { tool: string; arguments: Record<string, unknown> };
type ToolResult = { ok: boolean; result?: unknown; error?: string };
type RuntimeResponse = { result?: unknown; error?: { message?: string }; ok?: boolean };
type RuntimeToolDescription = { name: string; description?: string; inputSchema?: unknown };
type AgentEvent = { type: "state.changed" | "tool.call" | "tool.result"; state?: string; call?: ToolCall; result?: ToolResult };
type AssistantMessage = { text: string; node: HTMLElement };
const MAX_ROUNDS = 12;
const RESPONSE_TIMEOUT_MS = 120000;
const RPC_TIMEOUT_MS = 15000;
let running = false;

function emit(event: AgentEvent): void {
  try { chrome.runtime.sendMessage({ type: "agent.event", params: event }, () => { void chrome.runtime.lastError; }); } catch { /* stale extension context */ }
}
function runtimeRpc(message: Record<string, unknown>): Promise<RuntimeResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; window.clearTimeout(timer); fn(); };
    const timer = window.setTimeout(() => finish(() => reject(new Error("Timed out waiting for local Runtime"))), RPC_TIMEOUT_MS);
    try {
      chrome.runtime.sendMessage(message, (response: RuntimeResponse | undefined) => {
        if (chrome.runtime.lastError) { finish(() => reject(new Error(chrome.runtime.lastError?.message ?? "Extension message failed"))); return; }
        if (!response) { finish(() => reject(new Error("Extension returned no response"))); return; }
        finish(() => resolve(response));
      });
    } catch (error) { finish(() => reject(error instanceof Error ? error : new Error(String(error)))); }
  });
}
function getComposer(): HTMLTextAreaElement | HTMLElement | null { return document.querySelector<HTMLTextAreaElement>("textarea") ?? document.querySelector<HTMLElement>("[contenteditable='true'][role='textbox']") ?? document.querySelector<HTMLElement>("[contenteditable='true']"); }
function setComposerValue(composer: HTMLTextAreaElement | HTMLElement, text: string): void {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) { const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set; if (!setter) throw new Error("Unable to set ChatGPT composer value"); setter.call(composer, text); composer.dispatchEvent(new Event("input", { bubbles: true })); return; }
  composer.textContent = text; composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}
function findSendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[data-testid="send-button"]:not([disabled]), button[aria-label="Send prompt"]:not([disabled]), button[aria-label="Send message"]:not([disabled])');
}
async function submitToChatGPT(text: string): Promise<void> {
  emit({ type: "state.changed", state: "submitting-prompt" });
  const composer = getComposer();
  if (!composer) throw new Error("ChatGPT composer was not found. Open a normal ChatGPT conversation.");
  setComposerValue(composer, text);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const button = findSendButton();
  if (button) {
    button.click();
    emit({ type: "state.changed", state: "prompt-submitted" });
  } else {
    composer.focus();
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
    emit({ type: "state.changed", state: "prompt-submitted-enter" });
  }
  await new Promise((resolve) => setTimeout(resolve, 700));
}
function assistantMessages(): AssistantMessage[] {
  const roleNodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='assistant']"));
  if (roleNodes.length > 0) return roleNodes.map((node) => ({ text: node.innerText.trim(), node })).filter((item) => item.text.length > 0);
  return Array.from(document.querySelectorAll<HTMLElement>("article")).map((node) => ({ text: node.innerText.trim(), node })).filter((item) => item.text.length > 0);
}
async function waitForAssistantResponse(previousNode: HTMLElement | null, previousText: string): Promise<string> {
  emit({ type: "state.changed", state: "waiting-assistant" });
  const started = Date.now(); let lastText = ""; let stableSince = 0;
  while (Date.now() - started < RESPONSE_TIMEOUT_MS) {
    const messages = assistantMessages();
    const current = messages[messages.length - 1];
    if (current) {
      const text = current.text;
      const isNewNode = current.node !== previousNode;
      const isChangedExistingNode = current.node === previousNode && text.length > previousText.length && text !== previousText;
      if ((isNewNode || isChangedExistingNode) && text) {
        if (text !== lastText) { lastText = text; stableSince = Date.now(); }
        if (lastText && stableSince > 0 && Date.now() - stableSince >= 1200) return lastText;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for ChatGPT response");
}
function parseToolPlan(text: string): { calls: ToolCall[]; done: boolean } {
  const cleaned = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim(); const candidates = [cleaned, cleaned.match(/\{[\s\S]*\}/)?.[0] ?? ""];
  for (const candidate of candidates) { if (!candidate) continue; try { const value = JSON.parse(candidate) as unknown; if (!value || typeof value !== "object") continue; const record = value as { calls?: unknown; done?: unknown }; if (!Array.isArray(record.calls)) continue; const calls = record.calls.map((item, index) => { if (!item || typeof item !== "object") throw new Error(`Invalid tool call ${index + 1}`); const call = item as { tool?: unknown; arguments?: unknown }; if (typeof call.tool !== "string") throw new Error(`Tool call ${index + 1} has no tool name`); if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error(`Arguments for ${call.tool} must be an object`); return { tool: call.tool, arguments: call.arguments as Record<string, unknown> }; }); return { calls, done: record.done === true || calls.length === 0 }; } catch { /* continue */ } }
  throw new Error("ChatGPT did not return the required JSON tool plan");
}
function plannerPrompt(goal: string, tools: RuntimeToolDescription[], history: Array<{ call: ToolCall; result: ToolResult }>): string { return ["You are the coding-agent planner operating in the user's logged-in ChatGPT browser session.", "The local computer is available only through the listed tools. Never claim local state that a tool result does not confirm.", "Plan only the NEXT batch of tool calls. If a previous call failed, diagnose the actual error and choose a repair instead of blindly repeating it.", "Return JSON ONLY, with no markdown or explanation.", 'When the task is complete, return {"done":true,"calls":[]}. Otherwise return {"done":false,"calls":[{"tool":"...","arguments":{}}]}.', `Goal: ${goal}`, `Available tools: ${JSON.stringify(tools)}`, `Execution history: ${JSON.stringify(history)}`].join("\n\n"); }
function finalPrompt(goal: string, history: Array<{ call: ToolCall; result: ToolResult }>): string { return ["The local Browser Coding Agent has finished executing tools for the user's request.", "Answer the original user normally, using only the execution history as evidence.", "Do not claim a file was changed, a command succeeded, or a test passed unless the tool result confirms it.", "For inspection requests, summarize the useful files and findings. For failures, explain what failed.", "Do not return JSON.", `Original goal: ${goal}`, `Execution history: ${JSON.stringify(history)}`].join("\n\n"); }

async function runAgent(workspace: string, goal: string): Promise<void> {
  if (running) return; running = true; emit({ type: "state.changed", state: "planning" });
  try {
    emit({ type: "state.changed", state: "workspace-select" });
    const selected = await runtimeRpc({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "workspace.select", params: { path: workspace } });
    if (selected.error) throw new Error(selected.error.message ?? "Workspace selection failed");
    emit({ type: "state.changed", state: "tools-list" });
    const toolsResponse = await runtimeRpc({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools.list" });
    if (toolsResponse.error) throw new Error(toolsResponse.error.message ?? "Unable to list tools");
    const tools: RuntimeToolDescription[] = Array.isArray(toolsResponse.result) ? toolsResponse.result as RuntimeToolDescription[] : [];
    const history: Array<{ call: ToolCall; result: ToolResult }> = [];
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const previous = assistantMessages().at(-1);
      await submitToChatGPT(plannerPrompt(goal, tools, history));
      const responseText = await waitForAssistantResponse(previous?.node ?? null, previous?.text ?? "");
      const plan = parseToolPlan(responseText);
      if (plan.done) {
        const finalBefore = assistantMessages().at(-1);
        await submitToChatGPT(finalPrompt(goal, history));
        await waitForAssistantResponse(finalBefore?.node ?? null, finalBefore?.text ?? "");
        emit({ type: "state.changed", state: "completed" }); return;
      }
      emit({ type: "state.changed", state: "inspecting" });
      for (const call of plan.calls) {
        emit({ type: "tool.call", call });
        const response = await runtimeRpc({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tool.call", params: { call } });
        const result: ToolResult = response.error ? { ok: false, error: response.error.message ?? "Runtime tool call failed" } : response.result as ToolResult;
        history.push({ call, result }); emit({ type: "tool.result", call, result });
      }
      emit({ type: "state.changed", state: "planning" });
    }
    throw new Error(`Agent stopped after ${MAX_ROUNDS} planning rounds`);
  } finally { running = false; }
}

try {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false; const request = message as Record<string, unknown>;
    if (request.type === "chatgpt.ping") { sendResponse({ ok: true }); return false; }
    if (request.type === "chatgpt.bridge.diagnostic") {
      const composer = getComposer(); const assistants = assistantMessages(); const button = findSendButton();
      sendResponse({ ok: true, diagnostic: { composer: Boolean(composer), composerTag: composer?.tagName ?? null, sendButton: Boolean(button), assistantCount: assistants.length, latestAssistantTextLength: assistants.at(-1)?.text.length ?? 0, url: location.href } }); return false;
    }
    if (request.type === "chatgpt.bridge.test") {
      void (async () => {
        try {
          const previous = assistantMessages().at(-1); emit({ type: "state.changed", state: "bridge-test" });
          await submitToChatGPT("Please reply with exactly BROWSER_AGENT_BRIDGE_OK and nothing else.");
          const text = await waitForAssistantResponse(previous?.node ?? null, previous?.text ?? "");
          emit({ type: "state.changed", state: "bridge-test-passed" });
          emit({ type: "tool.result", result: { ok: true, result: { text } } });
        } catch (error) { emit({ type: "state.changed", state: "bridge-test-failed" }); emit({ type: "tool.result", result: { ok: false, error: error instanceof Error ? error.message : String(error) } }); }
      })();
      sendResponse({ ok: true }); return false;
    }
    if (request.type !== "chatgpt.start") return false;
    const workspace = typeof request.workspace === "string" ? request.workspace : ""; const goal = typeof request.goal === "string" ? request.goal : "";
    if (!workspace || !goal) { sendResponse({ ok: false, error: "Workspace and goal are required" }); return false; }
    void runAgent(workspace, goal).catch((error: unknown) => { emit({ type: "state.changed", state: "failed" }); emit({ type: "tool.result", result: { ok: false, error: error instanceof Error ? error.message : String(error) } }); });
    sendResponse({ ok: true }); return false;
  });
} catch { /* stale extension context */ }
export {};
