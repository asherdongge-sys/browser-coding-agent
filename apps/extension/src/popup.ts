import { formatApprovalCommand, type ApprovalRequest, type ApprovalResponse } from "./approval.js";

const status = document.querySelector<HTMLDivElement>("#status")!;
const approval = document.querySelector<HTMLDivElement>("#approval")!;
const description = document.querySelector<HTMLParagraphElement>("#description")!;
const command = document.querySelector<HTMLDivElement>("#command")!;
const risk = document.querySelector<HTMLSpanElement>("#risk")!;
const deny = document.querySelector<HTMLButtonElement>("#deny")!;
const allow = document.querySelector<HTMLButtonElement>("#allow")!;
const session = document.querySelector<HTMLButtonElement>("#session")!;

let current: ApprovalRequest | undefined;

function showRequest(request: ApprovalRequest): void {
  current = request;
  status.classList.add("hidden");
  approval.classList.remove("hidden");
  description.textContent = request.description;
  command.textContent = formatApprovalCommand(request);
  risk.textContent = request.risk.toUpperCase();
}

function respond(decision: ApprovalResponse["decision"]): void {
  if (!current) return;
  const requestId = current.requestId;
  chrome.runtime.sendMessage({ type: "approval.respond", requestId, decision }, () => {
    if (chrome.runtime.lastError) status.textContent = chrome.runtime.lastError.message ?? "发送失败";
    else status.textContent = decision === "deny" ? "已拒绝" : "已授权，正在执行…";
    status.classList.remove("hidden");
    approval.classList.add("hidden");
    current = undefined;
  });
}

deny.addEventListener("click", () => respond("deny"));
allow.addEventListener("click", () => respond("allow_once"));
session.addEventListener("click", () => respond("allow_session"));

chrome.runtime.sendMessage({ type: "approval.current" }, (response?: { request?: ApprovalRequest }) => {
  if (response?.request) showRequest(response.request);
  else status.textContent = "Runtime 已连接。等待 Agent 请求授权。";
});

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object") return;
  const event = message as { type?: string; request?: ApprovalRequest };
  if (event.type === "approval.request" && event.request) showRequest(event.request);
});
