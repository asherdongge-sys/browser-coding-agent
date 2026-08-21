declare module "ws" {
  import type { Server as HttpServer } from "node:http";
  import type { IncomingMessage } from "node:http";

  export class WebSocket {
    static readonly OPEN: number;
    on(event: "message", listener: (data: Buffer) => void): this;
    on(event: "close", listener: () => void): this;
    send(data: string): void;
  }

  export class WebSocketServer {
    constructor(options: { server: HttpServer });
    on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
  }
}
