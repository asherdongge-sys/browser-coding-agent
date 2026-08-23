import { Page } from "playwright";

const TRACE_ENABLED = process.env.BROWSER_CODING_AGENT_TRACE_CHATGPT === "1" || process.argv.includes("--trace-chatgpt");
const MAX_BODY = 12000;
const INTERESTING = /chatgpt|openai|backend-api|conversation|response|completion|mcp|connector|tool/i;
const SECRET_KEY = /authorization|cookie|set-cookie|token|secret|api[_-]?key|access[_-]?token/i;

let installed = false;

function safeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? "[REDACTED]" : safeJson(item);
    }
    return out;
  }
  return value;
}

function truncate(value: string): string {
  return value.length <= MAX_BODY ? value : `${value.slice(0, MAX_BODY)}…[truncated]`;
}

function formatPayload(value: unknown): string {
  if (typeof value === "string") {
    try { return truncate(JSON.stringify(safeJson(JSON.parse(value)))); } catch { return truncate(value); }
  }
  try { return truncate(JSON.stringify(safeJson(value))); } catch { return String(value); }
}

function shouldTrace(url: string): boolean {
  return INTERESTING.test(url);
}

function installPageTrace(page: Page): void {
  if (!TRACE_ENABLED) return;
  const marker = Symbol.for("browser-coding-agent.chatgpt-network-trace");
  const state = page as Page & { [marker]?: boolean };
  if (state[marker]) return;
  state[marker] = true;

  page.on("request", (request) => {
    const url = request.url();
    if (!shouldTrace(url)) return;
    const method = request.method();
    const resourceType = request.resourceType();
    let postData = "";
    try {
      const data = request.postData();
      if (data) postData = ` body=${formatPayload(data)}`;
    } catch { /* best-effort diagnostics */ }
    console.error(`[ChatGPTTrace][request] ${method} ${url} type=${resourceType}${postData}`);
  });

  page.on("response", (response) => {
    const url = response.url();
    if (!shouldTrace(url)) return;
    const contentType = response.headers()["content-type"] ?? "";
    console.error(`[ChatGPTTrace][response] ${response.status()} ${url} type=${contentType}`);
    if (!/json|text|event-stream/i.test(contentType)) return;
    void response.body().then((body) => {
      if (!body?.length) return;
      console.error(`[ChatGPTTrace][response-body] ${url} ${formatPayload(body.toString("utf8"))}`);
    }).catch(() => undefined);
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!shouldTrace(url)) return;
    console.error(`[ChatGPTTrace][request-failed] ${request.method()} ${url} ${request.failure()?.errorText ?? "unknown"}`);
  });

  page.on("websocket", (ws) => {
    const url = ws.url();
    if (!shouldTrace(url)) return;
    console.error(`[ChatGPTTrace][websocket-open] ${url}`);
    ws.on("framesent", ({ payload }) => console.error(`[ChatGPTTrace][ws-sent] ${url} ${formatPayload(payload)}`));
    ws.on("framereceived", ({ payload }) => console.error(`[ChatGPTTrace][ws-received] ${url} ${formatPayload(payload)}`));
    ws.on("socketerror", (error) => console.error(`[ChatGPTTrace][ws-error] ${url} ${error}`));
    ws.on("close", () => console.error(`[ChatGPTTrace][websocket-close] ${url}`));
  });
}

if (TRACE_ENABLED && !installed) {
  installed = true;
  const originalOn = Page.prototype.on;
  Page.prototype.on = function patchedOn(this: Page, event: any, handler: any) {
    installPageTrace(this);
    return originalOn.call(this, event, handler);
  } as typeof Page.prototype.on;
  console.error("[ChatGPTTrace] enabled: observing ChatGPT/OpenAI network and WebSocket traffic (secrets redacted)");
}
