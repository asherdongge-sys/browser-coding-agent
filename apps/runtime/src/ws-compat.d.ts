import "ws";

declare module "ws" {
  interface WebSocket {
    readonly readyState: number;
  }
}
