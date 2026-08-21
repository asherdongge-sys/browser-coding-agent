type AgentMessage = { type: "agent.message"; agentId: string; role: "user" | "assistant"; text: string; url: string };
type AgentEvent =
  | { type: "agent.state"; agentId: string; state: string; url: string }
  | AgentMessage
  | { type: "agent.auth"; agentId: string; authenticated: boolean; url: string };

type BridgeSnapshot = {
  authenticated: boolean;
  composer: boolean;
  composerTag: string | null;
  sendButton: boolean;
  assistantCount: number;
  latestAssistantText: string;
  url: string;
};

const RESPONSE_TIMEOUT_MS = 120000;
let busy = false;

function emit(event: AgentEvent): void {
  try {
    chrome.runtime.sendMessage({ type: "agent.event", params: event }, () => { void chrome.runtime.lastError; });
  } catch {
    // Ignore stale extension contexts after an extension reload.
  }
}

function visible<T extends HTMLElement>(nodes: T[]): T | null {
  return nodes.find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
  }) ?? null;
}

function getComposer(): HTMLTextAreaElement | HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.matches("[contenteditable='true'], [role='textbox']") && active.getBoundingClientRect().height > 0) return active;
  const editable = visible(Array.from(document.querySelectorAll<HTMLElement>("[contenteditable='true'][role='textbox'], [contenteditable='true']")));
  if (editable) return editable;
  return visible(Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea")));
}

function findSendButton(): HTMLButtonElement | null {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[type="submit"]',
    'form button:not([disabled])',
  ];
  for (const selector of selectors) {
    const button = visible(Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).filter((item) => !item.disabled));
    if (button) return button;
  }
  return null;
}

function assistantMessages(): Array<{ text: string; node: HTMLElement }> {
  const roleNodes = Array.from(document.querySelectorAll<HTMLElement>("[data-message-author-role='assistant']"));
  if (roleNodes.length > 0) return roleNodes.map((node) => ({ text: node.innerText.trim(), node })).filter((item) => item.text);
  return Array.from(document.querySelectorAll<HTMLElement>("article"))
    .map((node) => ({ text: node.innerText.trim(), node }))
    .filter((item) => item.text);
}

function looksLoggedOut(): boolean {
  const url = location.href;
  if (/\/auth\//i.test(url) || /\/login/i.test(url)) return true;
  const body = document.body?.innerText ?? "";
  return /log in|sign in|登录|注册/i.test(body) && !getComposer();
}

function snapshot(): BridgeSnapshot {
  const composer = getComposer();
  const assistants = assistantMessages();
  return {
    authenticated: !looksLoggedOut() && Boolean(composer),
    composer: Boolean(composer),
    composerTag: composer?.tagName ?? null,
    sendButton: Boolean(findSendButton()),
    assistantCount: assistants.length,
    latestAssistantText: assistants.at(-1)?.text ?? "",
    url: location.href,
  };
}

function setComposerValue(composer: HTMLTextAreaElement | HTMLElement, text: string): void {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) throw new Error("Unable to set ChatGPT composer value");
    setter.call(composer, text);
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.execCommand("insertText", false, text);
  if ((composer.textContent ?? "") !== text) composer.textContent = text;
  composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

async function submit(text: string): Promise<"button" | "form" | "enter"> {
  const composer = getComposer();
  if (!composer) throw new Error("ChatGPT composer not found. Finish ChatGPT login first.");
  setComposerValue(composer, text);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const button = findSendButton();
  if (button) { button.click(); return "button"; }
  const form = composer.closest("form");
  if (form instanceof HTMLFormElement) { form.requestSubmit(); return "form"; }
  composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  composer.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  return "enter";
}

async function waitForAssistant(previousNode: HTMLElement | null, previousText: string): Promise<string> {
  const started = Date.now();
  let lastText = "";
  let stableSince = 0;
  while (Date.now() - started < RESPONSE_TIMEOUT_MS) {
    const current = assistantMessages().at(-1);
    if (current) {
      const changed = current.node !== previousNode || current.text.length > previousText.length;
      if (changed && current.text) {
        if (current.text !== lastText) { lastText = current.text; stableSince = Date.now(); }
        if (Date.now() - stableSince >= 1000) return current.text;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Timed out waiting for ChatGPT response after 120s");
}

async function sendAgentMessage(agentId: string, text: string): Promise<void> {
  if (busy) throw new Error("This agent is already waiting for a ChatGPT response");
  busy = true;
  emit({ type: "agent.state", agentId, state: "sending", url: location.href });
  emit({ type: "agent.message", agentId, role: "user", text, url: location.href });
  try {
    const previous = assistantMessages().at(-1);
    await submit(text);
    emit({ type: "agent.state", agentId, state: "waiting", url: location.href });
    const response = await waitForAssistant(previous?.node ?? null, previous?.text ?? "");
    emit({ type: "agent.message", agentId, role: "assistant", text: response, url: location.href });
    emit({ type: "agent.state", agentId, state: "idle", url: location.href });
  } catch (error) {
    emit({ type: "agent.state", agentId, state: "failed", url: location.href });
    throw error;
  } finally {
    busy = false;
  }
}

try {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    const request = message as Record<string, unknown>;
    const agentId = typeof request.agentId === "string" ? request.agentId : "";
    if (request.type === "agent.ping") {
      sendResponse({ ok: true, snapshot: snapshot() });
      return false;
    }
    if (request.type === "agent.snapshot") {
      sendResponse({ ok: true, snapshot: snapshot() });
      return false;
    }
    if (request.type === "agent.send") {
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (!agentId || !text) { sendResponse({ ok: false, error: "agentId and text are required" }); return false; }
      void sendAgentMessage(agentId, text)
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    return false;
  });
} catch {
  // Ignore stale extension contexts.
}

export {};
