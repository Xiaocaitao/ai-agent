import type {
  EasyInputMessage,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
  ResponseStatus,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { ModelUsage } from "./usage.ts";

export type FunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: string;
};

// Agent 内部上下文直接使用 Responses API 的原生 item 结构。
export type AgentItem =
  | EasyInputMessage // 用户、系统的输入
  | ResponseOutputMessage // 模型文本回答
  | ResponseReasoningItem // 模型推理内容
  | ResponseFunctionToolCall // 模型发起的工具调用
  | FunctionCallOutputItem; // 工具执行后的结果

export type ModelResponse = {
  output: ResponseOutputItem[];
  output_text?: string;
  status?: ResponseStatus;
  usage?: ModelUsage;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
};

export type ResponseDelta = {
  kind: "reasoning" | "answer";
  text: string;
};

// 异步事件流
export type ResponseEventStream = AsyncIterable<ResponseStreamEvent>;

// OpenAI 兼容 ResponsesClient 接口抽象
export type ResponsesClient = {
  responses: {
    create(
      request: Record<string, unknown>,
    ): Promise<ModelResponse | ResponseEventStream>;
  };
};

export function isResponseEventStream(
  value: ModelResponse | ResponseEventStream,
): value is ResponseEventStream {
  return Symbol.asyncIterator in value;
}

// 消费事件流
export async function consumeResponseStream(
  stream: ResponseEventStream,
  onDelta: (delta: ResponseDelta) => void,
): Promise<ModelResponse> {
  for await (const event of stream) {
    if (event.type === "response.reasoning_text.delta") {
      onDelta({ kind: "reasoning", text: event.delta });
      continue;
    }
    if (event.type === "response.output_text.delta") {
      onDelta({ kind: "answer", text: event.delta });
      continue;
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      return event.response;
    }
  }
  throw new Error("流式响应结束时未收到终止事件");
}

// Agent 只保存推理、最终消息和工具调用三种模型输出。
export function agentOutputItems(items: ResponseOutputItem[]): AgentItem[] {
  const result: AgentItem[] = [];
  for (const item of items) {
    if (
      item.type === "reasoning" ||
      item.type === "message" ||
      item.type === "function_call"
    ) {
      result.push(item);
    }
  }
  return result;
}

// 从模型输出的 message item 中提取文本。
export function responseText(items: ResponseOutputItem[]): string {
  const text: string[] = [];
  for (const item of items) {
    if (item.type !== "message" || item.role !== "assistant") continue;
    for (const part of item.content) {
      if (part.type === "output_text") text.push(part.text);
    }
  }
  return text.join("");
}

// 递归转义字符串中的非法 Unicode 代理对为 U+FFFD，防止传给模型时出错。
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

export type { ResponseFunctionToolCall };
