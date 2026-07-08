import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import { configureWorkspace } from "./tools/index.ts";
import { loadTools, ToolRegistry } from "./tools/registry.ts";

// LLM返回的工具调用请求
type ToolCall = {
  id: string;
  type?: "function";
  function: { name: string; arguments: string }; // 函数名和入参
};

// 通用消息格式
type AgentMessage = {
  role: string; // user / assistant /tool
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string; // ?
};
type AssistantMessage = { content: string | null; tool_calls?: ToolCall[] };

// 鸭子类型，对openAI SDK 的最小约束
type ChatClient = {
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

// 验证工作目录
export async function resolveWorkspace(value: string): Promise<string> {
  const workspace = path.resolve(value);
  try {
    if (!(await stat(workspace)).isDirectory()) throw new Error();
    return workspace;
  } catch {
    throw new Error(`工作目录不存在或不是目录: ${workspace}`);
  }
}

export function sanitizeUnicode(value: unknown): unknown {
  if (typeof value === "string") return value.toWellFormed();
  // 函数引用
  if (Array.isArray(value)) return value.map(sanitizeUnicode);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeUnicode(item)]),
    );
  }
  return value;
}

// 包装模型回复
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
    return value.length > 200 ? `${value.slice(0, 200)}…<共 ${value.length} 字符>` : value;
  }
  if (Array.isArray(value)) return value.map((item) => summarizeLogValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [itemKey, summarizeLogValue(item, itemKey)]),
    );
  }
  return value;
}

function summarizeLogJson(value: string): string {
  try {
    return JSON.stringify(summarizeLogValue(JSON.parse(value)));
  } catch {
    return value.length > 200 ? `${value.slice(0, 200)}…<共 ${value.length} 字符>` : value;
  }
}

function finishReasonSuffix(value: string | null | undefined): string {
  return value ? `，finish_reason=${value}` : "";
}

export class ReActAgent {
  // readonly外部可读，但不能重新赋值
  readonly messages: AgentMessage[]; // 对话历史
  private readonly client: ChatClient; // LLM客户端
  private readonly model: string; // 模型名
  private readonly tools: ToolRegistry;
  private readonly maxSteps: number; // 最大步数上限

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
    // 用户输入
    this.messages.push({ role: "user", content: userInput });
    for (let step = 0; step < this.maxSteps; step += 1) {
      const stepLabel = `[Step ${step + 1}/${this.maxSteps}]`;
      output(`${stepLabel} → 请求模型`);
      // 拼请求
      const request: Record<string, unknown> = {
        model: this.model,
        messages: this.messages,
      };
      // 拼工具描述 auto表示让模型自己决定调不调
      if (this.tools.specs.length > 0)
        Object.assign(request, { tools: this.tools.specs, tool_choice: "auto" });
      const response = await this.client.chat.completions.create(
        sanitizeUnicode(request) as Record<string, unknown>,
      );
      const choice = response.choices[0];
      const message = choice?.message;
      if (!message) throw new Error("模型响应为空");
      this.messages.push(assistantMessage(message)); // 模型回复入队
      const finishReason = finishReasonSuffix(choice.finish_reason);
      if (!message.tool_calls?.length) {
        output(`${stepLabel} ← ${message.content ? "最终回答" : "空响应"}${finishReason}`);
        return message.content ?? "";
      }
      output(`${stepLabel} ← 工具调用，共 ${message.tool_calls.length} 个${finishReason}`);

      // 可能一次调多个工具
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const toolLabel = `  [Tool ${callIndex + 1}/${message.tool_calls.length}]`;
        const name = call.function.name;
        const rawArguments = call.function.arguments;
        output(`${toolLabel} Action: ${name}(${summarizeLogJson(rawArguments)})`);
        const observation = await this.tools.execute(name, rawArguments);
        output(`${toolLabel} Observation: ${summarizeLogJson(observation)}`);
        // 工具结果入队
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

async function main(): Promise<void> {
  // 设置工作目录
  const workspace = configureWorkspace(
    await resolveWorkspace(process.argv[2] ?? "."),
  );
  const runtime = await loadRuntime();
  const tools = await loadTools();
  const client = new OpenAI({
    apiKey: runtime.provider.AGENT_API_KEY,
    baseURL: runtime.provider.base_url,
  }) as unknown as ChatClient;
  const agent = new ReActAgent(
    client,
    runtime.provider.model,
    runtime.prompt,
    tools,
    runtime.maxSteps,
  );
  console.log(`ReAct Agent 已启动，工作目录: ${workspace}`);
  console.log("输入 exit 或 quit 退出。");
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const userInput = (await terminal.question("You: ")).trim();
      if (["exit", "quit"].includes(userInput.toLocaleLowerCase())) break;
      if (!userInput) continue;
      try {
        console.log(`Agent: ${await agent.runTurn(userInput)}`);
      } catch (error) {
        console.log(
          `Agent 错误: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  } finally {
    terminal.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      `配置错误: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
}
