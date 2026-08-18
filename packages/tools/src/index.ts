import type { ToolDescriptor, ToolResult } from "@browser-coding-agent/protocol";

export interface Tool<TArguments = unknown, TResult = unknown> {
  readonly descriptor: ToolDescriptor;
  execute(arguments_: TArguments): Promise<ToolResult<TResult>>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.descriptor.name)) {
      throw new Error(`Tool already registered: ${tool.descriptor.name}`);
    }
    this.tools.set(tool.descriptor.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): readonly ToolDescriptor[] {
    return [...this.tools.values()].map(({ descriptor }) => descriptor);
  }
}
