const RUNTIME_URL = "ws://127.0.0.1:4317";
const APPROVAL_URL = "approval.html";

type ApprovalRequest = { requestId: string; tool: string; risk: "read" | "write" | "execute" | "git"; description: string; arguments: unknown };
let socket: WebSocket | undefined;
let currentApproval: ApprovalRequest | undefined;

const log = (...args: unknown[]) => console.log("[BrowserCodingAgent]", ...args);
function broadcast(message: unknown): void { chrome.runtime.sendMessage(message).catch(() => undefined); }
async function openApprovalWindow(): Promise<void> {
  if (!currentApproval) return;
  const url = chrome.runtime.getURL(`${APPROVAL_URL}?requestId=${encodeURIComponent(currentApproval.requestId)}`);
  const existing = await chrome.tabs.query({ url: `${chrome.runtime.getURL(APPROVAL_URL)}*` }).catch(() => []);
  if (existing[0]?.id !== undefined) { await chrome.tabs.update(existing[0].id, { active: true }); return; }
  await chrome.windows.create({ url, type: "popup", width: 440, height: 620 });
}
async function notifyApproval(): Promise<void> {
  try { await chrome.notifications.create(`approval-${currentApproval?.requestId}`, { type: "basic", title: "Browser Coding Agent", message: `需要授权：${currentApproval?.tool ?? "tool"}`, priority: 2 }); } catch (error) { log("notification failed", error); }
}
function connectRuntime(): WebSocket {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return socket;
  const ws = new WebSocket(RUNTIME_URL);
  socket = ws;
  log("connecting runtime", RUNTIME_URL);
  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    log("runtime connected");
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "runtime.ping" }));
  });
  ws.addEventListener("message", (event) => {
    let message: unknown; try { message = JSON.parse(String(event.data)); } catch (error) { log("invalid runtime message", error); return; }
    if (!message || typeof message !== "object") return;
    const data = message as { method?: string; params?: Partial<ApprovalRequest> };
    log("runtime message", data.method ?? "response");
    if (data.method !== "approval.request" || !data.params?.requestId || !data.params.tool || !data.params.risk || !data.params.description) return;
    currentApproval = { requestId: data.params.requestId, tool: data.params.tool, risk: data.params.risk, description: data.params.description, arguments: data.params.arguments };
    log("approval request", currentApproval);
    broadcast({ type: "approval.request", request: currentApproval });
    void notifyApproval();
    void openApprovalWindow();
  });
  ws.addEventListener("close", () => { if (socket === ws) socket = undefined; log("runtime disconnected"); });
  ws.addEventListener("error", (event) => log("runtime socket error", event));
  return ws;
}
function sendToRuntime(message: Record<string, unknown>, sendResponse: (response: unknown) => void): void {
  const ws = connectRuntime();
  const send = () => {
    if (ws.readyState !== WebSocket.OPEN) { sendResponse({ ok: false, error: "Runtime WebSocket is not open" }); return; }
    ws.send(JSON.stringify(message)); sendResponse({ ok: true });
  };
  if (ws.readyState === WebSocket.OPEN) send(); else ws.addEventListener("open", send, { once: true });
}
chrome.runtime.onInstalled.addListener(() => { log("service worker installed"); connectRuntime(); });
chrome.runtime.onStartup.addListener(() => { log("service worker startup"); connectRuntime(); });
connectRuntime();
chrome.notifications.onClicked.addListener((notificationId) => { if (notificationId.startsWith("approval-")) void openApprovalWindow(); });
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const request = message as Record<string, unknown>;
  if (request.type === "approval.current") { sendResponse({ request: currentApproval }); return false; }
  if (request.type === "approval.respond") {
    const requestId = typeof request.requestId === "string" ? request.requestId : ""; const decision = request.decision;
    if (!requestId || (decision !== "allow_once" && decision !== "allow_session" && decision !== "deny")) { sendResponse({ ok: false, error: "Invalid approval response" }); return false; }
    sendToRuntime({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "approval.respond", params: { requestId, decision } }, sendResponse);
    if (currentApproval?.requestId === requestId) currentApproval = undefined;
    return true;
  }
  if ("jsonrpc" in request) { sendToRuntime(request, sendResponse); return true; }
  return false;
});
