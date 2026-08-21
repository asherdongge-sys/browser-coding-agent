import type { AgentState, ToolCall, ToolResult } from "@browser-coding-agent/protocol";

export interface AgentStep { readonly call: ToolCall; readonly result?: ToolResult; }
export interface AgentContext { readonly goal: string; readonly history: readonly AgentStep[]; }
export interface AgentRuntime { callTool<TArguments = unknown, TResult = unknown>(call: ToolCall<TArguments>): Promise<ToolResult<TResult>>; }
export interface AgentEvent { readonly type: "state.changed" | "tool.call" | "tool.result"; readonly state?: AgentState; readonly call?: ToolCall; readonly result?: ToolResult; }
export type AgentPlanner = (context: AgentContext) => Promise<readonly ToolCall[]>;

export class AgentLoop {
  private state: AgentState = "idle";
  private cancelled = false;
  private readonly maxSteps = 16;
  constructor(private readonly runtime: AgentRuntime, private readonly planner: AgentPlanner) {}
  getState(): AgentState { return this.state; }
  cancel(): void { this.cancelled = true; this.state = "cancelled"; }

  async run(context: AgentContext, emit: (event: AgentEvent) => void): Promise<void> {
    this.cancelled = false;
    if (!context.goal.trim()) { this.setState("failed", emit); throw new Error("Agent goal must not be empty"); }
    const history: AgentStep[] = [...context.history];
    for (let step = 0; step < this.maxSteps; step += 1) {
      if (this.cancelled) return;
      this.setState(step === 0 ? "planning" : history.at(-1)?.result?.ok === false ? "debugging" : "planning", emit);
      const calls = await this.planner({ goal: context.goal, history });
      if (calls.length === 0) { this.setState("completed", emit); return; }
      for (const call of calls) {
        if (this.cancelled) return;
        this.setState(call.tool === "fs.write" ? "editing" : call.tool === "terminal.exec" ? "testing" : "inspecting", emit);
        emit({ type: "tool.call", call });
        const result = await this.runtime.callTool(call);
        history.push({ call, result });
        emit({ type: "tool.result", call, result });
        if (!result.ok) break;
      }
    }
    this.setState("failed", emit);
  }

  private setState(state: AgentState, emit: (event: AgentEvent) => void): void { this.state = state; emit({ type: "state.changed", state }); }
}
