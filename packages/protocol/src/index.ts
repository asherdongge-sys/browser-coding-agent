export interface RpcRequest<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly method: string;
  readonly params?: TParams;
}

export interface RpcResponse<TResult = unknown> {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result?: TResult;
  readonly error?: RpcError;
}

export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface RpcNotification<TParams = unknown> {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: TParams;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export type AgentState =
  | "idle"
  | "planning"
  | "inspecting"
  | "editing"
  | "testing"
  | "debugging"
  | "reviewing"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly risk: "read" | "write" | "execute" | "git";
}

export interface ToolCall<TArguments = unknown> {
  readonly tool: string;
  readonly arguments: TArguments;
}

export interface ToolResult<TResult = unknown> {
  readonly ok: boolean;
  readonly result?: TResult;
  readonly error?: string;
}

export const PROTOCOL_VERSION = "0.1" as const;
