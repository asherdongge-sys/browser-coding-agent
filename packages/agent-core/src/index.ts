import type { AgentState, ToolCall, ToolResult } from "@browser-coding-agent/protocol";

export interface AgentContext {
  readonly goal: string;
}

export interface AgentRuntime {
  callTool<TArguments = unknown, TResult = unknown>(
    call: ToolCall<TArguments>,
  ): Promise<ToolResult<TResult>>;
}

export interface AgentEvent {
  readonly type: "state.changed" | "tool.call" | "tool.result";
  readonly state?: AgentState;
  readonly call?: ToolCall;
  readonly result?: ToolResult;
}

export class AgentLoop {
  private state: AgentState = "idle";
  private cancelled = false;

  constructor(private readonly runtime: AgentRuntime) {}

  getState(): AgentState {
    return this.state;
  }

  cancel(): void {
    this.cancelled = true;
    this.state = "cancelled";
  }

  async run(context: AgentContext, emit: (event: AgentEvent) => void): Promise<void> {
    this.cancelled = false;
    this.setState("planning", emit);

    // The first implementation intentionally keeps planning separate from
    // execution. An LLM planner will supply tool calls in the next phase.
    if (!context.goal.trim()) {
      this.setState("failed", emit);
      throw new Error("Agent goal must not be empty");
    }

    if (this.cancelled) return;
    this.setState("completed", emit);
  }

  private setState(state: AgentState, emit: (event: AgentEvent) => void): void {
    this.state = state;
    emit({ type: "state.changed", state });
  }
}
