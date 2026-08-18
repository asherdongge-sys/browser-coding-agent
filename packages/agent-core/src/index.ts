import type { AgentState, ToolCall, ToolResult } from "@browser-coding-agent/protocol";

export interface AgentContext { readonly goal: string; }
export interface AgentRuntime { callTool<TArguments = unknown, TResult = unknown>(call: ToolCall<TArguments>): Promise<ToolResult<TResult>>; }
export interface AgentEvent { readonly type: "state.changed" | "tool.call" | "tool.result"; readonly state?: AgentState; readonly call?: ToolCall; readonly result?: ToolResult; }
export type AgentPlanner = (context: AgentContext) => Promise<readonly ToolCall[]>;

export class AgentLoop {
  private state: AgentState = "idle";
  private cancelled = false;
  constructor(private readonly runtime: AgentRuntime, private readonly planner: AgentPlanner) {}
  getState(): AgentState { return this.state; }
  cancel(): void { this.cancelled = true; this.state = "cancelled"; }

  async run(context: AgentContext, emit: (event: AgentEvent) => void): Promise<void> {
    this.cancelled = false;
    if (!context.goal.trim()) { this.setState("failed", emit); throw new Error("Agent goal must not be empty"); }
    this.setState("planning", emit);
    const calls = await this.planner(context);
    for (const call of calls) {
      if (this.cancelled) return;
      this.setState(call.tool === "fs.write" ? "editing" : call.tool === "terminal.exec" ? "testing" : "inspecting", emit);
      emit({ type: "tool.call", call });
      const result = await this.runtime.callTool(call);
      emit({ type: "tool.result", call, result });
      if (!result.ok) { this.setState("failed", emit); return; }
    }
    if (!this.cancelled) this.setState("completed", emit);
  }

  private setState(state: AgentState, emit: (event: AgentEvent) => void): void { this.state = state; emit({ type: "state.changed", state }); }
}
