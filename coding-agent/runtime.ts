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

export type CompactionInput = {
  previousSummary?: string;
  throughTurnSequence: number;
  messages: AgentMessage[];
  recentMessages: AgentMessage[];
};

export function compactionMessage(summary: string): AgentMessage {
  return {
    role: "system",
    content: `会话历史摘要：\n${summary}`,
  };
}

// 存储适配接口
export type SessionRecorder = {
  startTurn(userInput: string): Promise<string>; // 开始当前轮次
  appendMessage(turnId: string, message: AgentMessage): Promise<void>; // 消息追加
  completeTurn(turnId: string): Promise<void>; // 本轮完成
  failTurn(turnId: string, error: unknown): Promise<void>; // 本轮失败
  prepareCompaction?(): Promise<CompactionInput | undefined>; // 预处理压缩
  saveCompaction?( // 保存压缩摘要
    summary: string,
    throughTurnSequence: number,
  ): Promise<void>;
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

function accumulateTokenUsage(total: TokenUsage, usage?: ModelUsage): void {
  const inputTokens = tokenCount(usage?.prompt_tokens);
  const outputTokens = tokenCount(usage?.completion_tokens);
  const reportedTotal = tokenCount(usage?.total_tokens);

  total.inputTokens += inputTokens;
  total.outputTokens += outputTokens;
  total.totalTokens += reportedTotal || inputTokens + outputTokens;
}

const CONTEXT_WARNING_RATIO = 0.8;
const COMPACTION_MAX_TOKENS = 4_000;
const COMPACTION_SYSTEM_PROMPT = `你负责压缩 Agent 会话历史。
请保留用户目标、关键决定、已修改文件、工具结果结论、错误信息和未完成事项。
删除重复对话、寒暄和冗长的工具原始输出。只输出可供后续模型继续工作的摘要。`;

function contextWarning(
  promptTokens: unknown,
  contextWindow: number | undefined,
): string | undefined {
  if (
    typeof promptTokens !== "number" ||
    !Number.isFinite(promptTokens) ||
    !Number.isInteger(promptTokens) ||
    promptTokens < 0 ||
    contextWindow === undefined
  ) {
    return undefined;
  }

  const ratio = promptTokens / contextWindow;
  if (ratio < CONTEXT_WARNING_RATIO) return undefined;
  return `[Context] 警告：上下文已使用 ${promptTokens}/${contextWindow} Tokens（${(ratio * 100).toFixed(1)}%）`;
}

export class ReActAgent {
  readonly messages: AgentMessage[];
  private readonly client: ChatClient;
  private readonly model: string;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly recorder?: SessionRecorder;
  private readonly contextWindow?: number;
  private pendingCompaction = false;
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
    initialMessages: AgentMessage[] = [], // 历史记录sqlite读的
    recorder?: SessionRecorder,
    contextWindow?: number,
  ) {
    this.client = client;
    this.model = model;
    this.tools = tools;
    this.maxSteps = maxSteps;
    this.recorder = recorder;
    this.contextWindow = contextWindow;
    this.messages = [
      { role: "system", content: systemPrompt },
      ...initialMessages,
    ];
  }

  // 返回副本，避免 CLI 或其他调用方改写会话累计值。
  get tokenUsage(): TokenUsage {
    return { ...this.usage };
  }

  get compactionPending(): boolean {
    return this.pendingCompaction;
  }

  // 更新完改状态
  applyCompaction(messages: AgentMessage[]): void {
    this.messages.splice(1, this.messages.length - 1, ...messages);
    this.pendingCompaction = false;
  }

  // 上下文压缩
  private async compactContext(
    currentTurnMessages: AgentMessage[],
    output: (line: string) => void,
  ): Promise<"compacted" | "unavailable" | "failed"> {
    const prepareCompaction = this.recorder?.prepareCompaction;
    const saveCompaction = this.recorder?.saveCompaction;
    if (prepareCompaction === undefined || saveCompaction === undefined) {
      return "unavailable";
    }
    try {
      // 预处理准备数据
      const input = await prepareCompaction();
      if (input === undefined) return "unavailable";
      // 进行摘要
      const summary = await this.createCompactionSummary(
        input.previousSummary,
        input.messages,
      );
      // 保存摘要
      await saveCompaction(summary, input.throughTurnSequence);
      // 更新上下文
      this.applyCompaction([
        compactionMessage(summary), // 摘要
        ...input.recentMessages, // 最近两条数据
        ...currentTurnMessages, // 当前轮次数据
      ]);
      output(
        `[Context] Compact 完成，摘要已覆盖到 Turn ${input.throughTurnSequence}`,
      );
      return "compacted";
    } catch (error) {
      output(
        `[Context] Compact 警告：${error instanceof Error ? error.message : error}`,
      );
      return "failed";
    }
  }

  // 摘要调用
  async createCompactionSummary(
    previousSummary: string | undefined,
    messages: AgentMessage[],
  ): Promise<string> {
    const compactMessages: AgentMessage[] = [
      { role: "system", content: COMPACTION_SYSTEM_PROMPT },
      ...(previousSummary === undefined
        ? []
        : [{
            role: "system",
            content: `此前的会话摘要：\n${previousSummary}`,
          }]),
      ...messages,
      { role: "user", content: "请输出更新后的会话摘要。" },
    ];
    const response = await this.client.chat.completions.create(
      sanitizeUnicode({
        model: this.model,
        messages: compactMessages,
        max_tokens: COMPACTION_MAX_TOKENS,
      }) as Record<string, unknown>,
    );
    accumulateTokenUsage(this.usage, response.usage);
    const summary = response.choices[0]?.message.content?.trim();
    if (!summary) throw new Error("模型返回的摘要为空");
    return summary;
  }

  // 运行一轮对话：思考 → 动作 → 观察，最多 maxSteps 步
  async runTurn(
    userInput: string,
    output: (line: string) => void = console.log,
  ): Promise<string> {
    // 上一轮没来得及压缩
    const preTurnCompaction = this.pendingCompaction
      ? await this.compactContext([], output)
      : "unavailable";
    const turnId = await this.recorder?.startTurn(userInput);
    // 当前轮次是否需要压缩
    let turnNeedsCompaction = false;
    // 当前轮次运行中是否检查过压缩
    let compactionCheckedWhileRunning = false;
    // 当前轮次压缩是否失败
    let compactionFailed = preTurnCompaction === "failed";
    // 记录当前轮次数据
    const currentTurnMessages: AgentMessage[] = [];
    try {
      const userMessage: AgentMessage = { role: "user", content: userInput };
      if (turnId !== undefined) {
        await this.recorder?.appendMessage(turnId, userMessage);
      }
      this.messages.push(userMessage);
      currentTurnMessages.push(userMessage);
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
        accumulateTokenUsage(this.usage, response.usage);
        // 检查当前上下文
        const warning = contextWarning(
          response.usage?.prompt_tokens,
          this.contextWindow,
        );
        if (warning !== undefined) {
          turnNeedsCompaction = true;
          output(warning);
        }
        const choice = response.choices[0];
        const message = choice?.message;
        if (!message) throw new Error("模型响应为空");
        const savedAssistantMessage = assistantMessage(message);
        if (turnId !== undefined) {
          await this.recorder?.appendMessage(turnId, savedAssistantMessage);
        }
        this.messages.push(savedAssistantMessage);
        currentTurnMessages.push(savedAssistantMessage);
        const finishReason = finishReasonSuffix(choice.finish_reason);
        // 没有工具调用 → 返回最终文本
        if (!message.tool_calls?.length) {
          if (turnId !== undefined) {
            await this.recorder?.completeTurn(turnId);
          }
          this.pendingCompaction ||= turnNeedsCompaction;
          // 需要压缩且本轮没失败过
          if (this.pendingCompaction && !compactionFailed) {
            const compacted = await this.compactContext([], output);
            if (compacted === "failed") compactionFailed = true;
          }
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
          const toolMessage: AgentMessage = {
            role: "tool",
            tool_call_id: call.id,
            content: observation,
          };
          if (turnId !== undefined) {
            await this.recorder?.appendMessage(turnId, toolMessage);
          }
          this.messages.push(toolMessage);
          // 本轮数组记录工具调用结果
          currentTurnMessages.push(toolMessage);
        }

        // 需要压缩且这轮没压缩过
        if (turnNeedsCompaction && !compactionCheckedWhileRunning) {
          this.pendingCompaction = true;
          const compacted = await this.compactContext(
            currentTurnMessages,
            output,
          );
          compactionCheckedWhileRunning = true;
          if (compacted === "compacted") {
            turnNeedsCompaction = false;
          }
          if (compacted === "failed") compactionFailed = true;
        }
      }
      // 超出步数上限，抛出错误
      throw new Error(`已达到最大步骤数 ${this.maxSteps}`);
    } catch (error) {
      if (turnId !== undefined) {
        await this.recorder?.failTurn(turnId, error);
      }
      throw error;
    }
  }
}
