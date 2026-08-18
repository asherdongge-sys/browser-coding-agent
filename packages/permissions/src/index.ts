export type PermissionRisk = "read" | "write" | "execute" | "git";

export type PermissionDecision = "allow" | "deny" | "ask";

export interface PermissionPolicy {
  readonly defaultDecision: PermissionDecision;
  readonly rules?: Readonly<Record<PermissionRisk, PermissionDecision>>;
}

export interface PermissionRequest {
  readonly tool: string;
  readonly risk: PermissionRisk;
  readonly description: string;
}

export class PermissionManager {
  constructor(private readonly policy: PermissionPolicy) {}

  decide(request: PermissionRequest): PermissionDecision {
    return this.policy.rules?.[request.risk] ?? this.policy.defaultDecision;
  }
}
