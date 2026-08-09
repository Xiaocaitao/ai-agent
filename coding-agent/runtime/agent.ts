import { ToolRegistry } from "../tools/registry.ts";
import type { FileChange } from "../file_change_tracker.ts";
import {
  agentOutputItems,
  consumeResponseStream,
  isResponseEventStream,
  responseText,
  sanitizeUnicode,
  type AgentItem,
  type FunctionCallOutputItem,
  type ResponseDelta,
  type ResponseFunctionToolCall,
  type ResponsesClient,
} from "./responses.ts";
import {
  accumulateTokenUsage,
  contextWarning,
  type TokenUsage,
} from "./usage.ts";
import {
  responseStatusSuffix,
  summarizeLogJson,
} from "./logging.ts";
import {
  COMPACTION_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
  compactionMessage,
} from "./compaction.ts";
import type { SessionRecorder } from "./session.ts";

export class ReActAgent {
  readonly items: AgentItem[]; // 本次连接的长上下文
  private readonly client: ResponsesClient;
  private readonly model: string;
  private readonly systemPrompt: string;
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number;
  private readonly recorder?: SessionRecorder;
  private readonly contextWindow?: number;
  private pendingCompaction = false;
  private lastFileChanges: FileChange[] = [];
  private readonly usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(
    client: ResponsesClient,
    model: string,
    systemPrompt: string,
    tools: ToolRegistry,
    maxSteps: number,
    initialItems: AgentItem[] = [],
    recorder?: SessionRecorder,
    contextWindow?: number,
  ) {
    this.client = client;
    this.model = model;
    this.systemPrompt = systemPrompt; // 系统提示词
    this.tools = tools;
    this.maxSteps = maxSteps;
    this.recorder = recorder;
    this.contextWindow = contextWindow;
    this.items = [...initialItems];
  }

  get tokenUsage(): TokenUsage {
    return { ...this.usage };
  }

  get compactionPending(): boolean {
    return this.pendingCompaction;
  }

  get lastTurnFileChanges(): FileChange[] {
    return this.lastFileChanges.map((change) => ({ ...change }));
  }

  applyCompaction(items: AgentItem[]): void {
    this.items.splice(0, this.items.length, ...items);
    this.pendingCompaction = false;
  }

  private async compactContext(
    currentTurnItems: AgentItem[],
    output: (line: string) => void,
  ): Promise<"compacted" | "unavailable" | "failed"> {
    const prepareCompaction = this.recorder?.prepareCompaction;
    const saveCompaction = this.recorder?.saveCompaction;
    if (prepareCompaction === undefined || saveCompaction === undefined) {
      return "unavailable";
    }
    try {
      const input = await prepareCompaction();
      if (input === undefined) return "unavailable";
      const summary = await this.createCompactionSummary(
        input.previousSummary,
        input.items,
      );
      await saveCompaction(summary, input.throughTurnSequence);
      this.applyCompaction([
        compactionMessage(summary),
        ...input.recentItems,
        ...currentTurnItems,
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

  async createCompactionSummary(
    previousSummary: string | undefined,
    items: AgentItem[],
  ): Promise<string> {
    const compactItems: AgentItem[] = [
      ...(previousSummary === undefined
        ? []
        : [compactionMessage(previousSummary)]),
      ...items,
      { type: "message", role: "user", content: "请输出更新后的会话摘要。" },
    ];
    const response = await this.client.responses.create(
      sanitizeUnicode({
        model: this.model,
        instructions: COMPACTION_SYSTEM_PROMPT,
        input: compactItems,
        max_output_tokens: COMPACTION_MAX_TOKENS,
      }) as Record<string, unknown>,
    );
    if (isResponseEventStream(response)) {
      throw new Error("Compact 请求意外返回了流式响应");
    }
    accumulateTokenUsage(this.usage, response.usage);
    const summary = (response.output_text || responseText(response.output)).trim();
    if (!summary) throw new Error("模型返回的摘要为空");
    return summary;
  }

  async runTurn(
    userInput: string,
    output: (line: string) => void = console.log,
    onDelta: (delta: ResponseDelta) => void = () => undefined,
  ): Promise<string> {
    this.lastFileChanges = [];
    this.tools.beginTurn(); // 刷新本轮的修改list
    const preTurnCompaction = this.pendingCompaction
      ? await this.compactContext([], output)
      : "unavailable";
    const turnId = await this.recorder?.startTurn(userInput);
    let turnNeedsCompaction = false;
    let compactionCheckedWhileRunning = false;
    let compactionFailed = preTurnCompaction === "failed";
    let turnUsedTools = false;
    const currentTurnItems: AgentItem[] = []; // 记录当前轮次的item
    try {
      const userItem: AgentItem = {
        type: "message",
        role: "user",
        content: userInput,
      };
      if (turnId !== undefined) {
        await this.recorder?.appendItem(turnId, userItem);
      }
      this.items.push(userItem);
      currentTurnItems.push(userItem);

      for (let step = 0; step < this.maxSteps; step += 1) {
        const stepLabel = `[Step ${step + 1}/${this.maxSteps}]`;
        output(`${stepLabel} → 请求模型`);
        const request: Record<string, unknown> = {
          model: this.model,
          instructions: this.systemPrompt,
          input: this.items,
          stream: true,
        };
        if (this.tools.specs.length > 0) {
          Object.assign(request, {
            tools: this.tools.specs,
            tool_choice: "auto", // 模型自由选择
          });
        }
        const responseStream = await this.client.responses.create(
          sanitizeUnicode(request) as Record<string, unknown>,
        );
        if (!isResponseEventStream(responseStream)) {
          throw new Error("流式请求未返回事件流");
        }
        const response = await consumeResponseStream(responseStream, onDelta);
        if (response.status === "failed") {
          throw new Error(response.error?.message ?? "模型响应失败");
        }
        if (response.status === "incomplete") {
          throw new Error(
            `模型响应不完整${response.incomplete_details?.reason ? `：${response.incomplete_details.reason}` : ""}`,
          );
        }
        accumulateTokenUsage(this.usage, response.usage);
        const warning = contextWarning(
          response.usage?.input_tokens,
          this.contextWindow,
        );
        if (warning !== undefined) {
          turnNeedsCompaction = true;
          output(warning);
        }

        const outputItems = agentOutputItems(response.output);
        const calls = outputItems.filter((item) =>
          item.type === "function_call"
        ) as ResponseFunctionToolCall[];
        // 标记这轮是否使用过工具
        turnUsedTools ||= calls.length > 0;
        // 使用过就整体存下，否则不存推理
        const savedItems = turnUsedTools
          ? outputItems
          : outputItems.filter((item) => item.type !== "reasoning");
        for (const item of savedItems) {
          if (turnId !== undefined) {
            await this.recorder?.appendItem(turnId, item);
          }
          this.items.push(item);
          currentTurnItems.push(item);
        }

        const status = responseStatusSuffix(response.status);
        // 无工具调用
        if (calls.length === 0) {
          const answer = response.output_text || responseText(response.output);
          if (turnId !== undefined) {
            await this.recorder?.completeTurn(turnId);
          }
          // 内容解析结束，判断是否需要压缩
          this.pendingCompaction ||= turnNeedsCompaction;
          if (this.pendingCompaction && !compactionFailed) {
            // 串行压缩
            const compacted = await this.compactContext([], output);
            if (compacted === "failed") compactionFailed = true;
          }
          output(
            `${stepLabel} ← ${answer ? "最终回答" : "空响应"}${status}`,
          );
          return answer;
        }
        output(`${stepLabel} ← 工具调用，共 ${calls.length} 个${status}`);

        for (const [callIndex, call] of calls.entries()) {
          const toolLabel = `  [Tool ${callIndex + 1}/${calls.length}]`;
          output(
            `${toolLabel} Action: ${call.name}(${summarizeLogJson(call.arguments)})`,
          );
          // 工具执行结果作为观察
          const observation = await this.tools.execute(
            call.name,
            call.arguments,
          );
          output(`${toolLabel} Observation: ${summarizeLogJson(observation)}`);
          const toolOutput: FunctionCallOutputItem = {
            type: "function_call_output",
            call_id: call.call_id,
            output: observation,
          };
          if (turnId !== undefined) {
            await this.recorder?.appendItem(turnId, toolOutput);
          }
          this.items.push(toolOutput);
          currentTurnItems.push(toolOutput);
        }

        if (turnNeedsCompaction && !compactionCheckedWhileRunning) {
          this.pendingCompaction = true;
          const compacted = await this.compactContext(
            currentTurnItems,
            output,
          );
          compactionCheckedWhileRunning = true;
          if (compacted === "compacted") turnNeedsCompaction = false;
          if (compacted === "failed") compactionFailed = true;
        }
      }
      throw new Error(`已达到最大步骤数 ${this.maxSteps}`);
    } catch (error) {
      if (turnId !== undefined) {
        await this.recorder?.failTurn(turnId, error);
      }
      throw error;
    } finally {
      this.lastFileChanges = this.tools.finishTurn();
    }
  }
}
