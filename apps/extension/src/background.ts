const RUNTIME_URL = "ws://127.0.0.1:4317";

let socket: WebSocket | undefined;

function connectRuntime(): WebSocket {
  if (socket?.readyState === WebSocket.OPEN) return socket;

  socket = new WebSocket(RUNTIME_URL);
  socket.addEventListener("open", () => {
    socket?.send(JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "runtime.ping",
    }));
  });
  socket.addEventListener("close", () => {
    socket = undefined;
  });
  return socket;
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  const socket = connectRuntime();
  const request = message as Record<string, unknown>;

  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(request));
    sendResponse({ ok: true });
  } else {
    socket.addEventListener(
      "open",
      () => {
        socket.send(JSON.stringify(request));
        sendResponse({ ok: true });
      },
      { once: true },
    );
    return true;
  }

  return true;
});
