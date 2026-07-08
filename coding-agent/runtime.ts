import { ToolRegistry } from "./tools/registry.ts";

type ToolCall = {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
};

export type AgentMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type AssistantMessage = { content: string | null; tool_calls?: ToolCall[] };

export type ChatClient = {
  chat: {
    completions: {
      create(
        request: Record<string, unknown>,
      ): Promise<{
        choices: Array<{
          message: AssistantMessage;
          finish_reason?: string | null;
        }>;
      }>;
    };
  };
};

export function sanitizeUnicode(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed();
  if (Array.isArray(value)) return value.map(sanitizeUnicode);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeUnicode(item)]),
    );
  }
  return value;
}

function assistantMessage(message: AssistantMessage): AgentMessage {
  const result: AgentMessage = { role: "assistant" };
  if (message.content !== null) result.content = message.content;
  if (message.tool_calls?.length) result.tool_calls = message.tool_calls;
  return result;
}

const OMITTED_LOG_FIELDS = new Set(["content", "stdin", "stdout", "stderr"]);

function summarizeLogValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (OMITTED_LOG_FIELDS.has(key) && value.length > 0)
      return `<省略 ${value.length} 字符>`;
    return value.length > 200
      ? `${value.slice(0, 200)}…<共 ${value.length} 字符>`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => summarizeLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [
        itemKey,
        summarizeLogValue(item, itemKey),
      ]),
    );
  }
  return value;
}

function summarizeLogJson(value: string): string {
  try {
    return JSON.stringify(summarizeLogValue(JSON.parse(value)));
  } catch {
    return value.length > 200
      ? `${value.slice(0, 200)}…<共 ${value.length} 字符>`
      : value;
  }
}

function finishReasonSuffix(value: string | null | undefined): string {
  return value ? `，finish_reason=${value}` : "";
}

export class ReActAgent {
  readonly messages: AgentMessage[];
  private readonly client: ChatClient;
  private readonly model: string;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;

  constructor(
    client: ChatClient,
    model: string,
    systemPrompt: string,
    tools: ToolRegistry,
    maxSteps: number,
  ) {
    this.client = client;
    this.model = model;
    this.tools = tools;
    this.maxSteps = maxSteps;
    this.messages = [{ role: "system", content: systemPrompt }];
  }

  async runTurn(
    userInput: string,
    output: (line: string) => void = console.log,
  ): Promise<string> {
    this.messages.push({ role: "user", content: userInput });
    for (let step = 0; step < this.maxSteps; step += 1) {
      const stepLabel = `[Step ${step + 1}/${this.maxSteps}]`;
      output(`${stepLabel} → 请求模型`);
      const request: Record<string, unknown> = {
        model: this.model,
        messages: this.messages,
      };
      if (this.tools.specs.length > 0)
        Object.assign(request, { tools: this.tools.specs, tool_choice: "auto" });
      const response = await this.client.chat.completions.create(
        sanitizeUnicode(request) as Record<string, unknown>,
      );
      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) throw new Error("模型响应为空");
      this.messages.push(assistantMessage(message));
      const finishReason = finishReasonSuffix(choice.finish_reason);
      if (!message.tool_calls?.length) {
        output(
          `${stepLabel} ← ${message.content ? "最终回答" : "空响应"}${finishReason}`,
        );
        return message.content ?? "";
      }
      output(
        `${stepLabel} ← 工具调用，共 ${message.tool_calls.length} 个${finishReason}`,
      );

      for (const [callIndex, call] of message.tool_calls.entries()) {
        const toolLabel = `  [Tool ${callIndex + 1}/${message.tool_calls.length}]`;
        const name = call.function.name;
        const rawArguments = call.function.arguments;
        output(
          `${toolLabel} Action: ${name}(${summarizeLogJson(rawArguments)})`,
        );
        const observation = await this.tools.execute(name, rawArguments);
        output(`${toolLabel} Observation: ${summarizeLogJson(observation)}`);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: observation,
        });
      }
    }
    throw new Error(`已达到最大步骤数 ${this.maxSteps}`);
  }
}
