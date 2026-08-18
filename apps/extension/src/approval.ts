export interface ApprovalRequest {
  readonly requestId: string;
  readonly tool: string;
  readonly risk: "read" | "write" | "execute" | "git";
  readonly description: string;
  readonly arguments: unknown;
}

export interface ApprovalResponse {
  readonly requestId: string;
  readonly decision: "allow_once" | "allow_session" | "deny";
}

export function formatApprovalCommand(request: ApprovalRequest): string {
  if (request.tool !== "terminal.exec") return request.tool;
  const args = request.arguments as { command?: unknown };
  return typeof args.command === "string" ? args.command : "(command unavailable)";
}
