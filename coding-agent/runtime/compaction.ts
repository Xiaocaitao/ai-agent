import type { AgentItem } from "./responses.ts";

export const COMPACTION_MAX_TOKENS = 4_000;
export const COMPACTION_SYSTEM_PROMPT = `你负责压缩 Agent 会话历史。
请保留用户目标、关键决定、已修改文件、工具结果结论、错误信息和未完成事项。
删除重复对话、寒暄和冗长的工具原始输出。只输出可供后续模型继续工作的摘要。`;

export function compactionMessage(summary: string): AgentItem {
  return {
    type: "message",
    role: "system",
    content: `会话历史摘要：\n${summary}`,
  };
}
