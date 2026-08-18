const RUNTIME_URL = "ws://127.0.0.1:4317";

type ApprovalRequest = { requestId: string; tool: string; risk: "read" | "write" | "execute" | "git"; description: string; arguments: unknown };
let socket: WebSocket | undefined;
let currentApproval: ApprovalRequest | undefined;

function broadcast(message: unknown): void { chrome.runtime.sendMessage(message).catch(() => undefined); }
function connectRuntime(): WebSocket {
  if (socket?.readyState === WebSocket.OPEN) return socket;
  socket = new WebSocket(RUNTIME_URL);
  socket.addEventListener("open", () => socket?.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "runtime.ping" })));
  socket.addEventListener("message", (event) => {
    let message: unknown; try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message || typeof message !== "object") return;
    const data = message as { method?: string; params?: Partial<ApprovalRequest> };
    if (data.method !== "approval.request" || !data.params?.requestId || !data.params.tool || !data.params.risk || !data.params.description) return;
    currentApproval = { requestId: data.params.requestId, tool: data.params.tool, risk: data.params.risk, description: data.params.description, arguments: data.params.arguments };
    broadcast({ type: "approval.request", request: currentApproval });
  });
  socket.addEventListener("close", () => { socket = undefined; });
  return socket;
}
function sendToRuntime(message: Record<string, unknown>, sendResponse: (response: unknown) => void): void {
  const runtimeSocket = connectRuntime();
  const send = () => { runtimeSocket.send(JSON.stringify(message)); sendResponse({ ok: true }); };
  if (runtimeSocket.readyState === WebSocket.OPEN) send(); else runtimeSocket.addEventListener("open", send, { once: true });
}
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
