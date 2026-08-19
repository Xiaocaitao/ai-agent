import { DatabaseSync } from "node:sqlite";

export type AgentDescriptor = {
  id: "coding-agent" | "pi";
  version?: string;
  provider: string;
  model: string;
  executionProfile: "host-model-proxy" | "direct-provider-egress";
  stepLimit?: number | null;
};

export type AgentBehaviorMetrics = {
  turns: number | null;
  steps: number | null;
  toolCalls: number | null;
  toolCallsByName: Record<string, number> | null;
  toolFailures: number | null;
  modelRequests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  contextCompactions: number | null;
  filesChanged: number | null;
  verificationCommands: number | null;
  /** 最新 session 从首个 turn 开始到最后一个 turn 完成的耗时（毫秒）。 */
  sessionDurationMs?: number | null;
};

export type TaskMetrics = {
  schemaVersion: 1;
  source: "live" | "historical-estimate";
  taskId: string;
  agent: AgentDescriptor;
  correctness: {
    resolved: boolean;
    failToPass: { passed: number; total: number };
    passToPass: { passed: number; total: number };
  };
  durationMs: {
    workspacePrepare: number | null;
    workerStartup: number | null;
    agent: number | null;
    grading: number | null;
    total: number | null;
  };
  agentBehavior: AgentBehaviorMetrics;
  artifacts: {
    session: string | null;
    agentLog: string | null;
    graderLog: string | null;
  };
};

export type BatchMetricsSummary = {
  taskCount: number;
  resolvedCount: number;
  resolvedRate: number;
  averageFailToPass: number;
  averagePassToPass: number;
  totalTokens: number | null;
  totalToolCalls: number | null;
  totalDurationMs: number | null;
};

export type CorrectnessMetrics = TaskMetrics["correctness"];

type FunctionCall = { type: "function_call"; call_id?: string; name?: string; arguments?: unknown };
type FunctionCallOutput = { type: "function_call_output"; call_id?: string; output?: unknown };

function nullableSum(values: Array<number | null>): number | null {
  return values.some((value) => value === null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJson(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function isVerificationCommand(argumentsValue: unknown): boolean {
  const input = parseJson(argumentsValue);
  const values = [input?.command, input?.cmd, input?.args]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /\b(pytest|test|tox|nox|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle(?:w)?\s+test)\b/i.test(values);
}

function toolOutputFailed(output: unknown): boolean {
  const parsed = parseJson(output);
  if (parsed === undefined) return false;
  return parsed.error != null || parsed.sandbox_denied === true || parsed.exit_code === null;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function scoreGroup(
  value: unknown,
  fallbackTotal: number,
): { passed: number; total: number } {
  const group = record(value);
  const success = stringArray(group?.success);
  const failure = stringArray(group?.failure);
  if (success !== undefined && failure !== undefined) {
    return { passed: success.length, total: success.length + failure.length };
  }
  const score = nonNegativeNumber(value);
  return { passed: Math.round(score * fallbackTotal), total: fallbackTotal };
}

/** 将官方 grader 的可变 JSON 归一化为便于跨 Agent 比较的通过数/总数。 */
export function buildCorrectnessMetrics(
  grade: Record<string, unknown>,
  expected: { failToPass?: number; passToPass?: number } = {},
): CorrectnessMetrics {
  const correctness = record(grade.correctness);
  const failTests = record(correctness?.failToPassTests);
  const passTests = record(correctness?.passToPassTests);
  return {
    resolved: grade.resolved === true,
    failToPass: scoreGroup(failTests ?? correctness?.failToPass, expected.failToPass ?? 0),
    passToPass: scoreGroup(passTests ?? correctness?.passToPass, expected.passToPass ?? 0),
  };
}

export function emptyAgentBehavior(): AgentBehaviorMetrics {
  return {
    turns: null,
    steps: null,
    toolCalls: null,
    toolCallsByName: null,
    toolFailures: null,
    modelRequests: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    contextCompactions: null,
    filesChanged: null,
    verificationCommands: null,
    sessionDurationMs: null,
  };
}

/**
 * 从已关闭的 Coding Agent session.sqlite 离线采集行为证据。
 * 该数据库只保存最后一份 compaction 摘要，因此 compaction 数是“已保存摘要数”，
 * 不是历史压缩动作的精确累计数；精确值由新的 Worker telemetry 覆盖。
 */
export function collectCodingAgentBehavior(sessionPath: string): AgentBehaviorMetrics {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(sessionPath, { readOnly: true });
    const latestSession = record(database.prepare(
      "SELECT id FROM sessions ORDER BY updated_at DESC LIMIT 1",
    ).get());
    const sessionId = latestSession?.id;
    if (typeof sessionId !== "string") return emptyAgentBehavior();
    const turnsRow = record(database.prepare(
      "SELECT COUNT(*) AS count FROM turns WHERE session_id = ?",
    ).get(sessionId));
    const compactionsRow = record(database.prepare(
      "SELECT COUNT(*) AS count FROM compactions WHERE session_id = ?",
    ).get(sessionId));
    const durationRow = record(database.prepare(
      "SELECT MIN(started_at) AS started_at, MAX(completed_at) AS completed_at FROM turns WHERE session_id = ?",
    ).get(sessionId));
    const rows = database.prepare(
      "SELECT payload_json FROM messages WHERE session_id = ? ORDER BY sequence",
    ).all(sessionId);
    const calls = new Map<string, FunctionCall>();
    const toolCallsByName: Record<string, number> = {};
    let toolCalls = 0;
    let toolFailures = 0;
    let verificationCommands = 0;
    let steps = 0;
    const startedAt = nonNegativeNumber(durationRow?.started_at);
    const completedAt = nonNegativeNumber(durationRow?.completed_at);
    const sessionDurationMs = completedAt >= startedAt ? completedAt - startedAt : null;

    for (const row of rows) {
      const payload = parseJson(record(row)?.payload_json);
      if (payload?.type === "reasoning") steps += 1;
      if (payload?.type === "function_call") {
        const call = payload as FunctionCall;
        const name = typeof call.name === "string" ? call.name : "unknown";
        toolCalls += 1;
        toolCallsByName[name] = (toolCallsByName[name] ?? 0) + 1;
        if (typeof call.call_id === "string") calls.set(call.call_id, call);
        if (name === "run_command" && isVerificationCommand(call.arguments)) {
          verificationCommands += 1;
        }
      }
      if (payload?.type === "function_call_output") {
        const output = payload as FunctionCallOutput;
        if (toolOutputFailed(output.output)) toolFailures += 1;
      }
    }

    return {
      ...emptyAgentBehavior(),
      turns: nonNegativeNumber(turnsRow?.count),
      steps,
      toolCalls,
      toolCallsByName,
      toolFailures,
      // 旧 session.sqlite 没有独立请求表，用 reasoning item 数作为请求的可复现估计。
      modelRequests: steps,
      // compactions 表是 session_id 的 upsert，只表示目前保留了几份摘要。
      contextCompactions: nonNegativeNumber(compactionsRow?.count),
      verificationCommands,
      sessionDurationMs,
    };
  } catch {
    return emptyAgentBehavior();
  } finally {
    database?.close();
  }
}

export function createTaskMetrics(input: TaskMetrics): TaskMetrics {
  return input;
}

export function summarizeMetrics(metrics: TaskMetrics[]): BatchMetricsSummary {
  const taskCount = metrics.length;
  const resolvedCount = metrics.filter((metric) => metric.correctness.resolved).length;
  const failToPass = metrics.map((metric) => {
    const value = metric.correctness.failToPass;
    return value.total === 0 ? 0 : value.passed / value.total;
  });
  const passToPass = metrics.map((metric) => {
    const value = metric.correctness.passToPass;
    return value.total === 0 ? 0 : value.passed / value.total;
  });
  return {
    taskCount,
    resolvedCount,
    resolvedRate: taskCount === 0 ? 0 : resolvedCount / taskCount,
    averageFailToPass: taskCount === 0 ? 0 : failToPass.reduce((sum, value) => sum + value, 0) / taskCount,
    averagePassToPass: taskCount === 0 ? 0 : passToPass.reduce((sum, value) => sum + value, 0) / taskCount,
    totalTokens: nullableSum(metrics.map((metric) => metric.agentBehavior.totalTokens)),
    totalToolCalls: nullableSum(metrics.map((metric) => metric.agentBehavior.toolCalls)),
    totalDurationMs: nullableSum(metrics.map((metric) => metric.durationMs.total)),
  };
}
