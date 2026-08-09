import type {
  EasyInputMessage,
  ResponseFunctionToolCall,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
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

// OpenAI 兼容 ResponsesClient 接口抽象
export type ResponsesClient = {
  responses: {
    create(request: Record<string, unknown>): Promise<{
      output: ResponseOutputItem[];
      output_text?: string;
      status?: "completed" | "incomplete" | "failed" | "in_progress";
      usage?: ModelUsage;
      error?: { message?: string } | null;
      incomplete_details?: { reason?: string } | null;
    }>;
  };
};

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
