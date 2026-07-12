import { ToolRegistry } from "./tools/registry.ts";

// LLM 返回的单个工具调用结构
type ToolCall = {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
};

// Agent 内部消息统一格式（system / user / assistant / tool）
export type AgentMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

// 模型原始返回的 assistant 消息
type AssistantMessage = { content: string | null; tool_calls?: ToolCall[] };

type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

// OpenAI 兼容 ChatClient 接口抽象
export type ChatClient = {
  chat: {
    completions: {
      create(request: Record<string, unknown>): Promise<{
        choices: Array<{
          message: AssistantMessage;
          finish_reason?: string | null;
        }>;
        usage?: ModelUsage;
      }>;
    };
  };
};

// 递归转义字符串中的非法 Unicode 代理对为 U+FFFD，防止传给模型时出错
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

// 将原始 assistant 消息转为内部 AgentMessage 格式
function assistantMessage(message: AssistantMessage): AgentMessage {
  const result: AgentMessage = { role: "assistant" };
  if (message.content !== null) result.content = message.content;
  if (message.tool_calls?.length) result.tool_calls = message.tool_calls;
  return result;
}

// 日志输出时省略这些大字段的原始内容，只显示长度
export const OMITTED_LOG_FIELDS = new Set([
  "content",
  "stdin",
  "stdout",
  "stderr",
]);

// 递归缩短日志字段值：过长字符串截断显示，content/stdin/stdout/stderr 等大字段只显示字符数
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

// 将工具调用的 JSON 参数转为可读的日志格式（大字段省略）
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

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export class ReActAgent {
  readonly messages: AgentMessage[];
  private readonly client: ChatClient;
  private readonly model: string;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

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

  // 返回副本，避免 CLI 或其他调用方改写会话累计值。
  get tokenUsage(): TokenUsage {
    return { ...this.usage };
  }

  // 运行一轮对话：思考 → 动作 → 观察，最多 maxSteps 步
  async runTurn(
    userInput: string,
    output: (line: string) => void = console.log,
  ): Promise<string> {
    this.messages.push({ role: "user", content: userInput });
    // ReAct 循环：最多 maxSteps 步，每步可调用一次模型
    for (let step = 0; step < this.maxSteps; step += 1) {
      const stepLabel = `[Step ${step + 1}/${this.maxSteps}]`;
      output(`${stepLabel} → 请求模型`);
      const request: Record<string, unknown> = {
        model: this.model,
        messages: this.messages,
      };
      // 有工具时带上 tools 和 tool_choice
      if (this.tools.specs.length > 0)
        Object.assign(request, {
          tools: this.tools.specs,
          tool_choice: "auto",
        });
      const response = await this.client.chat.completions.create(
        sanitizeUnicode(request) as Record<string, unknown>,
      );
      const inputTokens = tokenCount(response.usage?.prompt_tokens);
      const outputTokens = tokenCount(response.usage?.completion_tokens);
      this.usage.inputTokens += inputTokens;
      this.usage.outputTokens += outputTokens;
      this.usage.totalTokens += tokenCount(response.usage?.total_tokens) || inputTokens + outputTokens;
      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) throw new Error("模型响应为空");
      this.messages.push(assistantMessage(message));
      const finishReason = finishReasonSuffix(choice.finish_reason);
      // 没有工具调用 → 返回最终文本
      if (!message.tool_calls?.length) {
        output(
          `${stepLabel} ← ${message.content ? "最终回答" : "空响应"}${finishReason}`,
        );
        return message.content ?? "";
      }
      output(
        `${stepLabel} ← 工具调用，共 ${message.tool_calls.length} 个${finishReason}`,
      );

      // 逐个执行工具调用，结果反馈给模型进入下一轮
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const toolLabel = `  [Tool ${callIndex + 1}/${message.tool_calls.length}]`;
        const name = call.function.name;
        const rawArguments = call.function.arguments;
        output(
          `${toolLabel} Action: ${name}(${summarizeLogJson(rawArguments)})`,
        );
        // 工具注册表负责 schema 校验 + 执行 handler
        const observation = await this.tools.execute(name, rawArguments);
        output(`${toolLabel} Observation: ${summarizeLogJson(observation)}`);
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: observation,
        });
      }
    }
    // 超出步数上限，抛出错误
    throw new Error(`已达到最大步骤数 ${this.maxSteps}`);
  }
}
