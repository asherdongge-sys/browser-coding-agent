import { formatApprovalCommand, type ApprovalRequest, type ApprovalResponse } from "./approval.js";

const description = document.querySelector<HTMLParagraphElement>("#description")!;
const command = document.querySelector<HTMLDivElement>("#command")!;
const risk = document.querySelector<HTMLDivElement>("#risk")!;
const message = document.querySelector<HTMLDivElement>("#message")!;
const requestId = new URLSearchParams(location.search).get("requestId");
let current: ApprovalRequest | undefined;

function render(request: ApprovalRequest): void { current = request; description.textContent = request.description; command.textContent = formatApprovalCommand(request); risk.textContent = request.risk.toUpperCase(); }
function respond(decision: ApprovalResponse["decision"]): void {
  if (!current) return;
  chrome.runtime.sendMessage({ type: "approval.respond", requestId: current.requestId, decision }, (response?: { ok?: boolean; error?: string }) => {
    if (chrome.runtime.lastError || response?.ok === false) { message.textContent = chrome.runtime.lastError?.message ?? response?.error ?? "授权失败"; return; }
    message.textContent = decision === "deny" ? "已拒绝" : "已授权，正在执行…";
    setTimeout(() => window.close(), 500);
  });
}

document.querySelector<HTMLButtonElement>("#deny")!.onclick = () => respond("deny");
document.querySelector<HTMLButtonElement>("#allow")!.onclick = () => respond("allow_once");
document.querySelector<HTMLButtonElement>("#session")!.onclick = () => respond("allow_session");

chrome.runtime.sendMessage({ type: "approval.current" }, (response?: { request?: ApprovalRequest }) => {
  if (response?.request && (!requestId || response.request.requestId === requestId)) render(response.request);
  else message.textContent = "授权请求不存在或已经处理。";
});
