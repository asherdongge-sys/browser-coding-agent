import WebSocket from "ws";

const socket = new WebSocket("ws://127.0.0.1:4317");

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("WebSocket smoke test timed out")), 5000);

  socket.once("open", () => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "runtime.ping" }));
  });

  socket.once("message", (raw) => {
    clearTimeout(timeout);
    const message = JSON.parse(raw.toString());
    if (message.result?.ok !== true) {
      reject(new Error(`Unexpected response: ${raw.toString()}`));
      return;
    }
    console.log("WebSocket runtime.ping: OK");
    resolve();
    socket.close();
  });

  socket.once("error", reject);
});
