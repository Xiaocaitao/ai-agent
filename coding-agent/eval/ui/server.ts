import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import { loadRuntime, type Runtime } from "../../config.ts";
import {
  isResponseEventStream,
  responseText,
  type ResponseEventStream,
  type ResponsesClient,
} from "../../runtime/responses.ts";
import {
  runBatch,
  type BatchRunHooks,
  type BatchTaskArguments,
} from "../../scripts/swebench/batch_task.ts";
import { loadSWEbenchTasks } from "../../eval/swebench/task.ts";
import { MAX_EVAL_STEPS } from "../../eval/swebench/limits.ts";
import {
  COMPACTION_MAX_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
} from "../../runtime/compaction.ts";
import {
  EvaluationStore,
  assertAbsolutePath,
  assertSafeSegment,
  type EvalRunRecord,
} from "./store.ts";

const PUBLIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const CODING_AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_RESULTS_ROOT = path.resolve(CODING_AGENT_ROOT, "../eval-results");
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3210;
const MAX_BODY_BYTES = 2_000_000;
// DeepSeek Responses 兼容接口当前接受的 max_tokens 上限。
const ANALYSIS_MAX_OUTPUT_TOKENS = 393_216;
const ANALYSIS_SYSTEM_PROMPT_BYTES = 200_000;
const ANALYSIS_AGENT_TRACE_BYTES = 2_000_000;
const ANALYSIS_GRADER_LOG_BYTES = 1_000_000;
const ANALYSIS_MESSAGE_BYTES = 16_000;
const ANALYSIS_COMPACTION_BYTES = 64_000;

type Event = { type: string; [key: string]: unknown };
type RunState = {
  runId: string;
  resultsRoot: string;
  status: "running" | "completed" | "failed";
  events: Event[];
  clients: Set<ServerResponse>;
};

export type EvalServerOptions = {
  staticRoot?: string;
  defaultResultsRoot?: string;
  store?: EvaluationStore;
  batchRunner?: (args: BatchTaskArguments, hooks?: BatchRunHooks) => Promise<Record<string, unknown>>;
  runtimeLoader?: () => Promise<Runtime>;
  analysisClientFactory?: (runtime: Runtime) => ResponsesClient;
};

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

function sendEvent(res: ServerResponse, event: Event): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function requestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("请求体过大");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} 不能为空`);
  return value.trim();
}

function positiveInteger(value: unknown, label: string, maximum?: number): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || (maximum !== undefined && parsed > maximum)) {
    throw new Error(`${label} 必须是 1-${maximum ?? "正整数"} 的整数`);
  }
  return parsed;
}

function newRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomBytes(3).toString("hex")}`;
}

function hideProvider(runtime: Runtime): Record<string, unknown> {
  return {
    model: runtime.provider.model,
    baseUrl: runtime.provider.base_url,
    apiKeyConfigured: runtime.provider.AGENT_API_KEY.trim() !== "",
    maxSteps: runtime.maxSteps,
  };
}

function textWindow(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  return `${text.slice(0, half)}\n...[中间证据已截断，首尾保留]...\n${text.slice(-half)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function readToolConfig(): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(process.cwd(), "config", "tools.json"), "utf8"));
    return record(parsed);
  } catch {
    return undefined;
  }
}

function sessionEvidence(session: {
  session: Record<string, unknown> | undefined;
  turns: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  compactions: Record<string, unknown>[];
}): Record<string, unknown> {
  const messages = session.messages.map((message) => {
    const payload = message.payload;
    const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
    return {
      id: message.id,
      turnId: message.turn_id,
      sequence: message.sequence,
      role: message.role,
      payload: textWindow(serialized ?? "", ANALYSIS_MESSAGE_BYTES),
      createdAt: message.created_at,
    };
  });
  return {
    session: session.session,
    turns: session.turns,
    compactions: session.compactions.map((compaction) => ({
      sessionId: compaction.session_id,
      summary: textWindow(String(compaction.summary ?? ""), ANALYSIS_COMPACTION_BYTES),
      throughTurnSequence: compaction.through_turn_sequence,
      updatedAt: compaction.updated_at,
    })),
    messages,
  };
}

async function taskProblems(run: EvalRunRecord): Promise<Record<string, string>> {
  const options = record(run.metadata?.options);
  if (typeof options.tasks !== "string") return {};
  try {
    const tasks = await loadSWEbenchTasks(options.tasks);
    return Object.fromEntries(tasks.map((task) => [task.instanceId, task.problemStatement]));
  } catch {
    return {};
  }
}

function queryPath(url: URL, key: string): string {
  return assertAbsolutePath(url.searchParams.get(key) ?? "", key);
}

function routeParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

export function createEvalServer(options: EvalServerOptions = {}) {
  const store = options.store ?? new EvaluationStore();
  const batchRunner = options.batchRunner ?? runBatch;
  const runtimeLoader = options.runtimeLoader ?? loadRuntime;
  const analysisClientFactory = options.analysisClientFactory ?? ((runtime: Runtime) => new OpenAI({
    apiKey: runtime.provider.AGENT_API_KEY,
    baseURL: runtime.provider.base_url,
  }) as unknown as ResponsesClient);
  const staticRoot = options.staticRoot ?? PUBLIC_ROOT;
  const defaultResultsRoot = assertAbsolutePath(options.defaultResultsRoot ?? DEFAULT_RESULTS_ROOT, "defaultResultsRoot");
  const runs = new Map<string, RunState>();

  const publish = (run: RunState, event: Event): void => {
    run.events.push(event);
    for (const client of run.clients) sendEvent(client, event);
  };

  const startEvaluation = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tasks = requiredString(body, "tasks");
    const repoRoot = requiredString(body, "repoRoot");
    const workspacesRoot = requiredString(body, "workspaces");
    const resultsRoot = requiredString(body, "results");
    const image = requiredString(body, "image");
    const python = requiredString(body, "python");
    for (const [value, label] of [[tasks, "tasks"], [repoRoot, "repoRoot"], [workspacesRoot, "workspaces"], [resultsRoot, "results"], [python, "python"]] as const) {
      assertAbsolutePath(value, label);
    }
    if (body.containerWorkspace !== undefined) {
      assertAbsolutePath(requiredString(body, "containerWorkspace"), "containerWorkspace");
    }
    if (body.containerResults !== undefined) {
      assertAbsolutePath(requiredString(body, "containerResults"), "containerResults");
    }
    const runId = newRunId();
    const runResults = path.join(assertAbsolutePath(resultsRoot, "results"), runId);
    const runWorkspaces = path.join(assertAbsolutePath(workspacesRoot, "workspaces"), runId);
    await mkdir(runResults, { recursive: true });
    await mkdir(runWorkspaces, { recursive: true });
    const run: RunState = { runId, resultsRoot: assertAbsolutePath(resultsRoot, "results"), status: "running", events: [], clients: new Set() };
    runs.set(runId, run);
    const metadata = {
      runId,
      status: "running",
      createdAt: new Date().toISOString(),
      resultsRoot: run.resultsRoot,
      workspacesRoot: assertAbsolutePath(workspacesRoot, "workspaces"),
      options: { tasks, repoRoot, image, python, maxSteps: positiveInteger(body.maxSteps, "maxSteps", MAX_EVAL_STEPS) },
    };
    await writeFile(path.join(runResults, "run.json"), JSON.stringify(metadata, null, 2), "utf8");
    publish(run, { type: "run_start", runId, taskFile: tasks });

    void (async () => {
      const appendAgentLog = new Map<string, Promise<void>>();
      const appendLog = (taskId: string, line: string): void => {
        const filePath = path.join(runResults, taskId, "run", "agent.log");
        const previous = appendAgentLog.get(taskId) ?? Promise.resolve();
        const next = previous.then(async () => {
          await mkdir(path.dirname(filePath), { recursive: true });
          await appendFile(filePath, `${line}\n`, "utf8");
        }).catch(() => undefined);
        appendAgentLog.set(taskId, next);
      };
      const hooks: BatchRunHooks = {
        onTaskStart: (event) => publish(run, { type: "task_start", ...event }),
        onLog: ({ taskId, line }) => {
          appendLog(taskId, line);
          publish(run, { type: "log", taskId, line });
        },
        onTaskComplete: ({ taskId, report }) => publish(run, { type: "task_complete", taskId, report }),
      };
      try {
        const args: BatchTaskArguments = {
          tasks,
          repoRoot,
          workspaces: runWorkspaces,
          results: runResults,
          image,
          python,
          containerWorkspace: typeof body.containerWorkspace === "string" ? body.containerWorkspace : "/testbed",
          containerResults: typeof body.containerResults === "string" ? body.containerResults : "/results",
          maxSteps: positiveInteger(body.maxSteps, "maxSteps", MAX_EVAL_STEPS),
          verbose: true,
        };
        const summary = await batchRunner(args, hooks);
        run.status = (summary.resolvedRate as number) === 1 ? "completed" : "completed";
        const completedAt = new Date().toISOString();
        await writeFile(path.join(runResults, "run.json"), JSON.stringify({ ...metadata, status: run.status, completedAt }, null, 2), "utf8");
        publish(run, { type: "run_complete", runId, summary });
      } catch (error) {
        run.status = "failed";
        const message = errorMessage(error);
        await writeFile(path.join(runResults, "run.json"), JSON.stringify({ ...metadata, status: "failed", completedAt: new Date().toISOString(), error: message }, null, 2), "utf8");
        publish(run, { type: "run_error", runId, error: message });
      }
    })();
    return { runId, resultsRoot: run.resultsRoot, status: run.status };
  };

  const analyze = async (
    run: EvalRunRecord,
    res: ServerResponse,
    taskId?: string,
  ): Promise<void> => {
    sseHeaders(res);
    sendEvent(res, { type: "start" });
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) sendEvent(res, { type: "heartbeat" });
    }, 15_000);
    try {
      const runtime = await runtimeLoader();
      const allTasks: unknown[] = Array.isArray(run.summary?.tasks) ? run.summary.tasks : [];
      const tasks = taskId === undefined
        ? allTasks
        : allTasks.filter((value) => value !== null && typeof value === "object" && (value as Record<string, unknown>).taskId === taskId);
      if (taskId !== undefined && tasks.length === 0) throw new Error(`评测任务不存在: ${taskId}`);
      const problems = await taskProblems(run);
      const compact = tasks.map((value: unknown) => {
        if (value === null || typeof value !== "object") return value;
        const item = value as Record<string, unknown>;
        const grade = item.grade && typeof item.grade === "object" ? item.grade as Record<string, unknown> : {};
        const correctness = grade.correctness && typeof grade.correctness === "object" ? grade.correctness as Record<string, unknown> : {};
        const failures = Array.isArray(correctness.failToPassTests) ? correctness.failToPassTests : [];
        const run = item.run && typeof item.run === "object" ? item.run as Record<string, unknown> : {};
        const fileChanges = Array.isArray(run.fileChanges)
          ? run.fileChanges.map((change) => change && typeof change === "object" ? { path: (change as Record<string, unknown>).path, truncated: (change as Record<string, unknown>).truncated } : change)
          : [];
        return {
          taskId: item.taskId,
          problemStatement: typeof item.taskId === "string" ? problems[item.taskId] : undefined,
          run: {
            status: run.status,
            exitCode: run.exitCode,
            timedOut: run.timedOut,
            error: run.error,
            tokenUsage: run.tokenUsage,
            traceLines: run.traceLines,
            fileChanges,
          },
          metrics: item.metrics,
          resolved: grade.resolved,
          correctness,
          failures,
        };
      });
      const evidence: Record<string, unknown> = {
        run: {
          runId: run.runId,
          status: run.status,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
        },
        summaryMetrics: run.summary ? {
          taskCount: run.summary.taskCount,
          resolvedCount: run.summary.resolvedCount,
          resolvedRate: run.summary.resolvedRate,
          averageFailToPass: run.summary.averageFailToPass,
          averagePassToPass: run.summary.averagePassToPass,
          metrics: run.summary.metrics,
        } : undefined,
        tasks: compact,
        runtime: {
          model: runtime.provider.model,
          contextWindow: runtime.provider.context_window,
          maxSteps: runtime.maxSteps,
        },
        systemPrompt: textWindow(runtime.prompt, ANALYSIS_SYSTEM_PROMPT_BYTES),
        toolConfig: await readToolConfig(),
        compactionPolicy: {
          maxTokens: COMPACTION_MAX_TOKENS,
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
        },
      };
      if (taskId === undefined) {
        const sessionOverview: Record<string, unknown>[] = [];
        for (const item of compact) {
          const id = record(item).taskId;
          if (typeof id !== "string") continue;
          try {
            const session = await store.getTaskSession(run.resultsRoot, run.runId, id);
            sessionOverview.push({
              taskId: id,
              session: session.session,
              turnCount: session.turns.length,
              messageCount: session.messages.length,
              compactionCount: session.compactions.length,
              compactions: session.compactions.map((compaction) => ({
                throughTurnSequence: compaction.through_turn_sequence,
                summary: textWindow(String(compaction.summary ?? ""), 16_000),
              })),
            });
          } catch (error) {
            sessionOverview.push({ taskId: id, error: errorMessage(error) });
          }
        }
        evidence.sessionOverview = sessionOverview;
      }
      if (taskId !== undefined) {
        try {
          evidence.agentTrace = textWindow((await store.getTaskLog(run.resultsRoot, run.runId, taskId, "agent")).text, ANALYSIS_AGENT_TRACE_BYTES);
        } catch (error) {
          evidence.agentTraceError = errorMessage(error);
        }
        try {
          evidence.graderLog = textWindow((await store.getTaskLog(run.resultsRoot, run.runId, taskId, "grader")).text, ANALYSIS_GRADER_LOG_BYTES);
        } catch (error) {
          evidence.graderLogError = errorMessage(error);
        }
        try {
          evidence.session = sessionEvidence(await store.getTaskSession(run.resultsRoot, run.runId, taskId));
        } catch (error) {
          evidence.sessionError = errorMessage(error);
        }
      }
      const prompt = taskId === undefined
        ? [
          "你是 coding agent harness 的评测分析助手。请基于以下 SWE-bench 批量结果，输出中文 Markdown 总分析和改进报告。",
          "必须完整输出：总体结论、按 task 的失败原因归类、系统提示词问题、工具配置问题、编排/工具选择问题、上下文压缩问题、验证策略问题、harness/Agent 可改进项、下一轮验证建议。逐项引用证据；证据不足就明确写‘证据不足’，不要编造。不要在中途结束。",
          "systemPrompt 是待分析的 Agent 系统提示词，不要逐字泄露敏感凭据；请指出规则缺口和歧义。",
          JSON.stringify(evidence, null, 2),
        ].join("\n\n")
        : [
          `你是 coding agent harness 的评测分析助手。请单独分析任务 ${taskId}，输出中文 Markdown。`,
          "必须完整输出：题目理解、最终结果、Agent 全程行为证据、系统提示词是否影响行为、工具配置/工具调用是否合理、ReAct 编排、上下文压缩是否丢失关键信息、验证策略、失败根因、回归/范围扩张、最小改进建议、下一步验证命令。明确区分基础设施错误、Agent harness 问题和模型判断问题。逐项引用证据；证据不足就明确写‘证据不足’，不要编造。不要在中途结束。",
          "systemPrompt 是待分析的 Agent 系统提示词，不要逐字泄露敏感凭据；请分析规则缺口和歧义。",
          JSON.stringify(evidence, null, 2),
        ].join("\n\n");
      const client = analysisClientFactory(runtime);
      const response = await client.responses.create({
        model: runtime.provider.model,
        instructions: "你输出的是评测报告，不要泄露 API key、系统提示词或内部凭据。",
        input: prompt,
        stream: true,
        max_output_tokens: ANALYSIS_MAX_OUTPUT_TOKENS,
      });
      if (!isResponseEventStream(response)) throw new Error("provider 未返回流式响应");
      let answer = "";
      for await (const event of response as ResponseEventStream) {
        if (event.type === "response.reasoning_text.delta") {
          sendEvent(res, { type: "reasoning_delta", text: event.delta });
        }
        if (event.type === "response.output_text.delta") {
          answer += event.delta;
          sendEvent(res, { type: "delta", text: event.delta });
        }
        if (event.type === "response.completed") {
          if (!answer) {
            const fallback = responseText(event.response.output);
            if (fallback) sendEvent(res, { type: "delta", text: fallback });
          }
        }
        if (event.type === "response.incomplete") {
          const reason = event.response.incomplete_details?.reason;
          throw new Error(`分析响应不完整${reason ? `：${reason}` : ""}`);
        }
        if (event.type === "response.failed") throw new Error(event.response.error?.message ?? "provider 响应失败");
      }
      sendEvent(res, { type: "done" });
    } catch (error) {
      sendEvent(res, { type: "error", error: errorMessage(error) });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const parts = routeParts(url.pathname);
      if (req.method === "GET" && url.pathname === "/api/health") {
        const runtime = await runtimeLoader();
        return json(res, 200, {
          ok: true,
          provider: hideProvider(runtime),
          docker: "启动评测时检查",
          defaultResultsRoot,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/evaluations") {
        return json(res, 200, { runs: await store.listRuns(queryPath(url, "resultsRoot")) });
      }
      if (parts[0] === "api" && parts[1] === "evaluations" && parts[2]) {
        const runId = assertSafeSegment(parts[2], "runId");
        const active = runs.get(runId);
        const resultsRoot = active?.resultsRoot ?? queryPath(url, "resultsRoot");
        const run = await store.getRun(resultsRoot, runId);
        if (run === undefined) throw new Error(`评测记录不存在: ${runId}`);
        if (parts[3] === "events" && req.method === "GET") {
          sseHeaders(res);
          if (active === undefined) {
            sendEvent(res, { type: "run_snapshot", run });
            res.end();
            return;
          }
          for (const event of active.events) sendEvent(res, event);
          if (active.status !== "running") {
            res.end();
            return;
          }
          active.clients.add(res);
          req.on("close", () => active.clients.delete(res));
          return;
        }
        if (parts[3] === "tasks" && parts[4]) {
          const taskId = assertSafeSegment(parts[4], "taskId");
          if (parts[5] === "analyze" && req.method === "POST") return analyze(run, res, taskId);
          if (parts[5] === "session" && req.method === "GET") return json(res, 200, await store.getTaskSession(resultsRoot, runId, taskId));
          if (parts[5] === "log" && req.method === "GET") {
            const kind = url.searchParams.get("kind") === "grader" ? "grader" : "agent";
            return json(res, 200, await store.getTaskLog(resultsRoot, runId, taskId, kind));
          }
        }
        if (parts[3] === "analyze" && req.method === "POST") return analyze(run, res);
        if (req.method === "GET") return json(res, 200, run);
      }
      if (req.method === "POST" && url.pathname === "/api/evaluations") {
        return json(res, 202, await startEvaluation(await requestBody(req)));
      }
      if (req.method === "GET") {
        const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        if (requested.includes("..") || requested.includes("\\")) return json(res, 404, { error: "Not found" });
        const filePath = path.join(staticRoot, requested);
        const content = await readFile(filePath);
        const type = requested.endsWith(".css") ? "text/css" : requested.endsWith(".js") ? "text/javascript" : "text/html";
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        res.end(content);
        return;
      }
      json(res, 404, { error: "Not found" });
    } catch (error) {
      const message = errorMessage(error);
      json(res, message.includes("不存在") ? 404 : 400, { error: message });
    }
  });
  return server;
}

async function main(): Promise<void> {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : DEFAULT_PORT;
  const hostIndex = process.argv.indexOf("--host");
  const host = hostIndex >= 0 ? process.argv[hostIndex + 1] : DEFAULT_HOST;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 非法");
  const server = createEvalServer();
  server.listen(port, host, () => console.log(`评测控制台: http://${host}:${port}`));
}

const isMainModule = import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) main().catch((error) => { console.error(errorMessage(error)); process.exitCode = 1; });
