const RUNTIME_URL = "ws://127.0.0.1:4317";
const APPROVAL_URL = "approval.html";

type ApprovalRequest = { requestId: string; tool: string; risk: "read" | "write" | "execute" | "git"; description: string; arguments: unknown };
let socket: WebSocket | undefined;
let currentApproval: ApprovalRequest | undefined;
const pendingRpc = new Map<string, (response: unknown) => void>();

const log = (...args: unknown[]) => console.log("[BrowserCodingAgent]", ...args);
function broadcast(message: unknown): void {
  chrome.runtime.sendMessage(message, () => { void chrome.runtime.lastError; });
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
    const data = message as { method?: string; params?: Partial<ApprovalRequest>; id?: string | number; result?: unknown; error?: unknown };
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
  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) throw new Error("Open a ChatGPT tab first");
  await ensureChatGptBridge(tab.id);
  return tab.id;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const request = message as Record<string, unknown>;

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

  if (request.type === "agent.event") { broadcast({ type: "agent.event", params: request.params }); return false; }
  if (request.type === "approval.current") { sendResponse({ request: currentApproval }); return false; }
  if (request.type === "approval.respond") {
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    const decision = request.decision;
    if (!requestId || (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny")) {
      sendResponse({ ok: false, error: "Invalid approval response" }); return false;
    }
    sendToRuntime({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "approval.respond", params: { requestId, decision } }, sendResponse);
    if (currentApproval?.requestId === requestId) currentApproval = undefined;
    return true;
  }
  if ("jsonrpc" in request) { sendToRuntime(request, sendResponse); return true; }
  return false;
});

export {};
