export type ModelUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export const CONTEXT_WARNING_RATIO = 0.8;

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

export function accumulateTokenUsage(
  total: TokenUsage,
  usage?: ModelUsage,
): void {
  const inputTokens = tokenCount(usage?.input_tokens);
  const outputTokens = tokenCount(usage?.output_tokens);
  const reportedTotal = tokenCount(usage?.total_tokens);

  total.inputTokens += inputTokens;
  total.outputTokens += outputTokens;
  total.totalTokens += reportedTotal || inputTokens + outputTokens;
}

export function contextWarning(
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
