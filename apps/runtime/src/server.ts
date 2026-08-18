import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { RpcMessage } from "@browser-coding-agent/protocol";

export const DEFAULT_PORT = 4317;

export function createRuntimeServer(port = Number(process.env.BROWSER_CODING_AGENT_PORT ?? DEFAULT_PORT)) {
  const httpServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ name: "browser-coding-agent", protocol: "0.1" }));
  });

  const wsServer = new WebSocketServer({ server: httpServer });

  wsServer.on("connection", (socket) => {
    socket.on("message", (raw: Buffer) => {
      let message: RpcMessage;
      try {
        message = JSON.parse(raw.toString()) as RpcMessage;
      } catch {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: "invalid",
          error: { code: -32700, message: "Invalid JSON" },
        }));
        return;
      }

      if ("method" in message && message.method === "runtime.ping" && "id" in message) {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { ok: true, protocol: "0.1" },
        }));
      }
    });
  });

  return { httpServer, wsServer, port };
}

const runtime = createRuntimeServer();
runtime.httpServer.listen(runtime.port, "127.0.0.1", () => {
  console.log(`Browser Coding Agent runtime listening on 127.0.0.1:${runtime.port}`);
});
