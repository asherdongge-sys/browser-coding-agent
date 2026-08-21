import { formatApprovalCommand, type ApprovalRequest, type ApprovalResponse } from "./approval.js";

const description = document.querySelector<HTMLParagraphElement>("#description")!;
const command = document.querySelector<HTMLDivElement>("#command")!;
const risk = document.querySelector<HTMLDivElement>("#risk")!;
const message = document.querySelector<HTMLDivElement>("#message")!;
const deny = document.querySelector<HTMLButtonElement>("#deny")!;
const allow = document.querySelector<HTMLButtonElement>("#allow")!;
const session = document.querySelector<HTMLButtonElement>("#session")!;
const requestId = new URLSearchParams(location.search).get("requestId");

function respond(decision: ApprovalResponse["decision"]): void {
  if (!requestId) { message.textContent = "授权请求 ID 缺失。"; return; }
  chrome.runtime.sendMessage({ type: "approval.respond", requestId, decision }, (response?: { ok?: boolean; error?: string }) => {
    if (chrome.runtime.lastError || response?.ok === false) { message.textContent = chrome.runtime.lastError?.message ?? response?.error ?? "授权失败"; return; }
    message.textContent = decision === "deny" ? "已拒绝，可以关闭此窗口。" : "已授权，正在执行…";
    deny.disabled = allow.disabled = session.disabled = true;
    setTimeout(() => window.close(), 500);
  });
}
chrome.runtime.sendMessage({ type: "approval.current" }, (response?: { request?: ApprovalRequest }) => {
  if (chrome.runtime.lastError) { message.textContent = chrome.runtime.lastError.message ?? "无法读取授权请求"; return; }
  const request = response?.request;
  if (!request || (requestId && request.requestId !== requestId)) { message.textContent = "授权请求不存在或已经处理。"; return; }
  description.textContent = request.description;
  command.textContent = formatApprovalCommand(request);
  risk.textContent = request.risk.toUpperCase();
});
deny.addEventListener("click", () => respond("deny"));
allow.addEventListener("click", () => respond("allow_once"));
session.addEventListener("click", () => respond("allow_session"));
