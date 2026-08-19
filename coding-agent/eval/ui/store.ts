import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { collectCodingAgentBehavior } from "../swebench/metrics.ts";

// 保留较长的过程证据；最终能否接收仍由 provider 的上下文窗口决定。
const MAX_LOG_BYTES = 1_000_000;
const MAX_SESSION_MESSAGES = 2_000;

export type EvalRunRecord = {
  runId: string;
  status: string;
  createdAt?: string;
  completedAt?: string;
  resultsRoot: string;
  summary?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type SessionView = {
  session: Record<string, unknown> | undefined;
  turns: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  compactions: Record<string, unknown>[];
};

function payloadText(payload: unknown): string {
  if (!isRecord(payload)) return String(payload ?? "");
  const type = String(payload.type ?? "");
  if (type === "function_call") {
    return `${String(payload.name ?? "tool")}(${String(payload.arguments ?? "")})`;
  }
  if (type === "function_call_output") return String(payload.output ?? "");
  const content = payload.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!isRecord(part)) return String(part ?? "");
      return String(part.text ?? part.output_text ?? part.reasoning_text ?? "");
    }).filter(Boolean).join("\n");
  }
  return String(payload.text ?? "");
}

function formatSessionTrace(session: SessionView): string {
  return session.messages.map((message) => {
    const payload = message.payload;
    const type = isRecord(payload) ? String(payload.type ?? message.role ?? "message") : String(message.role ?? "message");
    const label = type === "function_call" ? "Tool" : type === "function_call_output" ? "Observation" : type === "reasoning" ? "Thinking" : type === "message" ? String(isRecord(payload) ? payload.role ?? "message" : "message") : type;
    return `[${label}] ${payloadText(payload)}`;
  }).join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hydrateLegacySummary(
  summary: Record<string, unknown> | undefined,
  runDirectoryPath: string,
): Record<string, unknown> | undefined {
  if (summary === undefined || !Array.isArray(summary.tasks)) return summary;
  let totalTokens = 0;
  let totalToolCalls = 0;
  let tokensKnown = false;
  let toolsKnown = false;
  const tasks = summary.tasks.map((value) => {
    if (!isRecord(value) || typeof value.taskId !== "string") return value;
    let safeTaskId: string;
    try {
      safeTaskId = assertSafeSegment(value.taskId, "taskId");
    } catch {
      return value;
    }
    const existing = isRecord(value.metrics) ? value.metrics : undefined;
    if (existing?.agentBehavior !== undefined) return value;
    const behavior = collectCodingAgentBehavior(path.join(runDirectoryPath, safeTaskId, "run", "session.sqlite"));
    if (behavior.toolCalls === null && behavior.steps === null) return value;
    const run = isRecord(value.run) ? value.run : {};
    const tokenUsage = isRecord(run.tokenUsage) ? run.tokenUsage : {};
    const totalTokenValue = numberOrNull(tokenUsage.totalTokens);
    if (totalTokenValue !== null) {
      tokensKnown = true;
      totalTokens += totalTokenValue;
    }
    if (behavior.toolCalls !== null) {
      toolsKnown = true;
      totalToolCalls += behavior.toolCalls;
    }
    return {
      ...value,
      metrics: {
        schemaVersion: 1,
        source: "historical-estimate",
        taskId: value.taskId,
        agent: {
          id: "coding-agent",
          provider: "configured-provider",
          model: "unknown",
          executionProfile: "host-model-proxy",
          stepLimit: null,
        },
        durationMs: {
          workspacePrepare: null,
          workerStartup: null,
          agent: behavior.sessionDurationMs ?? null,
          grading: null,
          total: null,
        },
        agentBehavior: {
          ...behavior,
          inputTokens: numberOrNull(tokenUsage.inputTokens),
          outputTokens: numberOrNull(tokenUsage.outputTokens),
          totalTokens: totalTokenValue,
        },
        artifacts: { session: "run/session.sqlite", agentLog: "run/agent.log", graderLog: "grade/eval.log" },
      },
    };
  });
  const oldMetrics = isRecord(summary.metrics) ? summary.metrics : {};
  return {
    ...summary,
    tasks,
    metrics: {
      ...oldMetrics,
      totalTokens: oldMetrics.totalTokens ?? (tokensKnown ? totalTokens : null),
      totalToolCalls: oldMetrics.totalToolCalls ?? (toolsKnown ? totalToolCalls : null),
      totalDurationMs: oldMetrics.totalDurationMs ?? null,
    },
  };
}

export function assertAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径`);
  return path.resolve(value);
}

export function assertSafeSegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error(`${label} 非法`);
  }
  return value;
}

function runDirectory(resultsRoot: string, runId: string): string {
  return path.join(assertAbsolutePath(resultsRoot, "resultsRoot"), assertSafeSegment(runId, "runId"));
}

function taskDirectory(resultsRoot: string, runId: string, taskId: string): string {
  return path.join(runDirectory(resultsRoot, runId), assertSafeSegment(taskId, "taskId"));
}

async function boundedText(filePath: string): Promise<{ text: string; truncated: boolean }> {
  try {
    const text = await readFile(filePath, "utf8");
    if (Buffer.byteLength(text, "utf8") <= MAX_LOG_BYTES) return { text, truncated: false };
    return { text: text.slice(-MAX_LOG_BYTES), truncated: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`记录文件不存在: ${path.basename(filePath)}`);
    }
    throw error;
  }
}

export class EvaluationStore {
  async listRuns(resultsRoot: string): Promise<EvalRunRecord[]> {
    const root = assertAbsolutePath(resultsRoot, "resultsRoot");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: EvalRunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)) continue;
      const record = await this.getRun(root, entry.name, false);
      if (record !== undefined) runs.push(record);
    }
    return runs.sort((left, right) =>
      String(right.createdAt ?? right.runId).localeCompare(String(left.createdAt ?? left.runId)));
  }

  async getRun(
    resultsRoot: string,
    runId: string,
    throwIfMissing = true,
  ): Promise<EvalRunRecord | undefined> {
    const root = assertAbsolutePath(resultsRoot, "resultsRoot");
    const safeRunId = assertSafeSegment(runId, "runId");
    const directory = runDirectory(root, safeRunId);
    const metadata = await readJson(path.join(directory, "run.json"));
    const storedSummary = await readJson(path.join(directory, "summary.json"));
    if (metadata === undefined && storedSummary === undefined) {
      if (throwIfMissing) throw new Error(`评测记录不存在: ${safeRunId}`);
      return undefined;
    }
    const summary = hydrateLegacySummary(storedSummary, directory);
    return {
      runId: safeRunId,
      status: String(metadata?.status ?? (summary === undefined ? "running" : "completed")),
      createdAt: typeof metadata?.createdAt === "string" ? metadata.createdAt : undefined,
      completedAt: typeof metadata?.completedAt === "string" ? metadata.completedAt : undefined,
      resultsRoot: root,
      metadata,
      summary,
    };
  }

  async getTaskSession(
    resultsRoot: string,
    runId: string,
    taskId: string,
  ): Promise<SessionView> {
    const databasePath = path.join(taskDirectory(resultsRoot, runId, taskId), "run", "session.sqlite");
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const session = database.prepare(`
        SELECT id, workspace_path, created_at, updated_at, last_model, system_prompt_hash
        FROM sessions ORDER BY updated_at DESC LIMIT 1
      `).get() as Record<string, unknown> | undefined;
      const turns = database.prepare(`
        SELECT id, sequence, user_input, status, started_at, completed_at, error
        FROM turns ORDER BY sequence
      `).all() as Record<string, unknown>[];
      const messages = database.prepare(`
        SELECT id, turn_id, sequence, role, payload_json, created_at
        FROM messages ORDER BY sequence LIMIT ${MAX_SESSION_MESSAGES}
      `).all().map((row) => {
        const value = row as Record<string, unknown>;
        let payload: unknown = value.payload_json;
        try { payload = JSON.parse(String(value.payload_json)); } catch { /* 保留原文 */ }
        return { ...value, payload };
      }) as Record<string, unknown>[];
      const compactions = database.prepare(`
        SELECT session_id, summary, through_turn_sequence, updated_at
        FROM compactions ORDER BY updated_at
      `).all() as Record<string, unknown>[];
      return { session, turns, messages, compactions };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`评测任务尚未产生 session.sqlite: ${taskId}`);
      }
      throw error;
    } finally {
      database?.close();
    }
  }

  async getTaskLog(
    resultsRoot: string,
    runId: string,
    taskId: string,
    kind: "agent" | "grader",
  ): Promise<{ text: string; truncated: boolean; kind: string }> {
    const fileName = kind === "agent" ? "agent.log" : "eval.log";
    const filePath = path.join(
      taskDirectory(resultsRoot, runId, taskId),
      kind === "agent" ? "run" : "grade",
      fileName,
    );
    try {
      return { ...(await boundedText(filePath)), kind };
    } catch (error) {
      if (kind !== "agent" || !(error instanceof Error) || !error.message.includes("agent.log")) throw error;
      // 旧评测没有单独的 agent.log，但完整的工具轨迹仍在 session.sqlite。
      const session = await this.getTaskSession(resultsRoot, runId, taskId);
      return { text: formatSessionTrace(session), truncated: false, kind };
    }
  }
}
