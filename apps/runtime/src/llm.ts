import type { AgentContext } from "@browser-coding-agent/agent-core";
import type { ToolCall, ToolDescriptor } from "@browser-coding-agent/protocol";

export interface LlmPlannerConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
}

interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export function getLlmPlannerConfig(env: NodeJS.ProcessEnv = process.env): LlmPlannerConfig | null {
  const apiKey = env.BCA_LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.BCA_LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/$/, ""),
    model: env.BCA_LLM_MODEL?.trim() || "gpt-4.1-mini",
  };
}

export function createLlmPlanner(config: LlmPlannerConfig, tools: readonly ToolDescriptor[]) {
  return async (context: AgentContext): Promise<readonly ToolCall[]> => {
    const system = buildSystemPrompt(tools);
    const history = context.history.map((step) => ({ tool: step.call.tool, arguments: step.call.arguments, result: step.result }));
    const messages: readonly ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ goal: context.goal, history }) },
    ];
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages, temperature: 0, response_format: { type: "json_object" } }),
    });
    if (!response.ok) throw new Error(`LLM request failed (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM returned an empty planner response");
    return parsePlannerResponse(content, tools);
  };
}

function buildSystemPrompt(tools: readonly ToolDescriptor[]): string {
  const toolText = tools.map((tool) => `- ${tool.name}: ${tool.description} [risk=${tool.risk}]`).join("\n");
  return [
    "You are the planning engine for a local browser coding agent.",
    "Plan only the next safe batch of tool calls. Observe tool results from history and repair failures instead of repeating the same failed call.",
    "Never invent tools. Arguments must be JSON objects matching the tool's purpose.",
    "When the task is complete, return an empty calls array.",
    "Return JSON only in this exact shape: {\"calls\":[{\"tool\":\"tool.name\",\"arguments\":{}}]}.",
    "Available tools:", toolText || "(none)",
  ].join("\n");
}

function parsePlannerResponse(content: string, tools: readonly ToolDescriptor[]): readonly ToolCall[] {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error("LLM planner returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { calls?: unknown }).calls)) throw new Error("LLM planner response must contain a calls array");
  const allowed = new Set(tools.map((tool) => tool.name));
  return (parsed as { calls: unknown[] }).calls.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Planner call ${index + 1} is invalid`);
    const call = item as { tool?: unknown; arguments?: unknown };
    if (typeof call.tool !== "string" || !allowed.has(call.tool)) throw new Error(`Planner selected an unavailable tool: ${String(call.tool)}`);
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) throw new Error(`Planner arguments for ${call.tool} must be an object`);
    return { tool: call.tool, arguments: call.arguments };
  });
}
