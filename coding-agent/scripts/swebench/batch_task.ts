import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadRuntime, type Runtime } from "../../config.ts";
import { runSWEbenchTask } from "../../eval/swebench/runner.ts";
import { loadSWEbenchTasks as loadTasks } from "../../eval/swebench/task.ts";
import { gradeTask } from "./grade_task.ts";
import { summarizeWorkerResult } from "./run_task.ts";
import { MAX_EVAL_STEPS } from "../../eval/swebench/limits.ts";
import {
  buildCorrectnessMetrics,
  collectCodingAgentBehavior,
  createTaskMetrics,
  summarizeMetrics,
  type BatchMetricsSummary,
  type TaskMetrics,
} from "../../eval/swebench/metrics.ts";

export type BatchTaskArguments = {
  tasks: string;
  repoRoot: string;
  workspaces: string;
  results: string;
  image: string;
  python: string;
  containerWorkspace: string;
  containerResults: string;
  maxSteps?: number;
  verbose: boolean;
};

export type BatchRunHooks = {
  onTaskStart?: (event: { taskId: string; index: number; total: number; phase: "run" | "grade" }) => void;
  onLog?: (event: { taskId: string; line: string }) => void;
  onTaskComplete?: (event: { taskId: string; report: Record<string, unknown> }) => void;
};

const FLAG_TO_KEY: Record<string, keyof BatchTaskArguments> = {
  "--tasks": "tasks",
  "--repo-root": "repoRoot",
  "--workspaces": "workspaces",
  "--results": "results",
  "--image": "image",
  "--python": "python",
  "--container-workspace": "containerWorkspace",
  "--container-results": "containerResults",
  "--max-steps": "maxSteps",
};
const REQUIRED = ["--tasks", "--repo-root", "--workspaces", "--results", "--image", "--python"];

export function parseBatchTaskArguments(values: string[]): BatchTaskArguments {
  const result: Partial<BatchTaskArguments> = {
    containerWorkspace: "/testbed",
    containerResults: "/results",
    verbose: false,
  };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag.startsWith("--")) throw new Error(`未知参数: ${flag}`);
    if (flag === "--verbose") {
      if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
      seen.add(flag);
      result.verbose = true;
      continue;
    }
    const key = FLAG_TO_KEY[flag];
    if (key === undefined) throw new Error(`未知参数: ${flag}`);
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    seen.add(flag);
    if (key === "maxSteps") {
      const maxSteps = Number(next);
      if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_EVAL_STEPS) {
        throw new Error(`--max-steps 必须是 1-${MAX_EVAL_STEPS} 的整数`);
      }
      result.maxSteps = maxSteps;
    } else {
      (result as Record<keyof BatchTaskArguments, unknown>)[key] = next;
    }
    index += 1;
  }
  for (const flag of REQUIRED) {
    const key = FLAG_TO_KEY[flag];
    if (result[key] === undefined || result[key] === "") {
      throw new Error(`缺少参数: ${flag}`);
    }
  }
  return result as BatchTaskArguments;
}

function assertSafeTaskId(taskId: string): void {
  if (!taskId || taskId === "." || taskId === ".." || /[\\/]/.test(taskId)) {
    throw new Error(`taskId 不能用于目录名: ${taskId}`);
  }
}

export function buildBatchTaskPaths(
  workspacesRoot: string,
  resultsRoot: string,
  taskId: string,
): { workspace: string; runResults: string; gradeResults: string } {
  assertSafeTaskId(taskId);
  const taskRoot = path.join(resultsRoot, taskId);
  return {
    workspace: path.join(workspacesRoot, taskId),
    runResults: path.join(taskRoot, "run"),
    gradeResults: path.join(taskRoot, "grade"),
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function taskMetricsFromReport(input: {
  task: Awaited<ReturnType<typeof loadTasks>>[number];
  runtime: Runtime;
  run: Record<string, unknown>;
  grade: Record<string, unknown>;
  paths: ReturnType<typeof buildBatchTaskPaths>;
  durationMs: TaskMetrics["durationMs"];
}): TaskMetrics {
  const stored = collectCodingAgentBehavior(path.join(input.paths.runResults, "session.sqlite"));
  const tokenUsage = record(input.run.tokenUsage);
  const fileChanges = Array.isArray(input.run.fileChanges) ? input.run.fileChanges.length : null;
  return createTaskMetrics({
    schemaVersion: 1,
    source: "live",
    taskId: input.task.instanceId,
    agent: {
      id: "coding-agent",
      provider: "configured-provider",
      model: input.runtime.provider.model,
      executionProfile: "host-model-proxy",
      stepLimit: input.runtime.maxSteps,
    },
    correctness: buildCorrectnessMetrics(input.grade, {
      failToPass: input.task.failToPass.length,
      passToPass: input.task.passToPass.length,
    }),
    durationMs: input.durationMs,
    agentBehavior: {
      ...stored,
      inputTokens: nullableNumber(tokenUsage?.inputTokens),
      outputTokens: nullableNumber(tokenUsage?.outputTokens),
      totalTokens: nullableNumber(tokenUsage?.totalTokens),
      filesChanged: fileChanges,
    },
    artifacts: {
      session: "run/session.sqlite",
      agentLog: "run/agent.log",
      graderLog: "grade/eval.log",
    },
  });
}

function metricsFromReports(reports: Record<string, unknown>[]): TaskMetrics[] {
  return reports.map((report) => report.metrics).filter(
    (metric): metric is TaskMetrics => metric !== null && typeof metric === "object" && !Array.isArray(metric),
  );
}

export type BatchResultSummary = {
  taskCount: number;
  resolvedCount: number;
  resolvedRate: number;
  averageFailToPass: number;
  averagePassToPass: number;
  metrics: BatchMetricsSummary;
};

export function summarizeBatchResults(
  results: Array<Record<string, unknown>>,
  metrics: TaskMetrics[] = [],
): BatchResultSummary {
  const taskCount = results.length;
  const resolvedCount = results.filter((result) => result.resolved === true).length;
  const failToPass = results.map((result) => numberValue(result.correctness && (result.correctness as Record<string, unknown>).failToPass));
  const passToPass = results.map((result) => numberValue(result.correctness && (result.correctness as Record<string, unknown>).passToPass));
  return {
    taskCount,
    resolvedCount,
    resolvedRate: taskCount === 0 ? 0 : resolvedCount / taskCount,
    averageFailToPass: taskCount === 0 ? 0 : failToPass.reduce((sum, value) => sum + value, 0) / taskCount,
    averagePassToPass: taskCount === 0 ? 0 : passToPass.reduce((sum, value) => sum + value, 0) / taskCount,
    metrics: summarizeMetrics(metrics),
  };
}

function errorReport(error: unknown): Record<string, unknown> {
  return {
    status: "error",
    error: error instanceof Error ? error.message : String(error),
  };
}

async function runOneTask(
  task: Awaited<ReturnType<typeof loadTasks>>[number],
  args: BatchTaskArguments,
  runtime: Runtime,
  index: number,
  total: number,
  hooks: BatchRunHooks = {},
): Promise<Record<string, unknown>> {
  const paths = buildBatchTaskPaths(args.workspaces, args.results, task.instanceId);
  const taskStartedAt = Date.now();
  let workspacePreparedAt: number | undefined;
  let workerStartedAt: number | undefined;
  hooks.onTaskStart?.({ taskId: task.instanceId, index, total, phase: "run" });
  console.error(`[${index}/${total}] ${task.instanceId}: run`);
  let run: Record<string, unknown>;
  try {
    const result = await runSWEbenchTask({
      runtime,
      task,
      repoRoot: args.repoRoot,
      workspace: paths.workspace,
      resultDirectory: paths.runResults,
      image: args.image,
      containerWorkspace: args.containerWorkspace,
      containerResults: args.containerResults,
      traceOutput: (line) => {
        if (args.verbose) console.error(`[${task.instanceId}] ${line}`);
        hooks.onLog?.({ taskId: task.instanceId, line });
      },
      onWorkspacePrepared: () => { workspacePreparedAt = Date.now(); },
      onWorkerStarted: () => { workerStartedAt = Date.now(); },
    });
    run = summarizeWorkerResult(result);
    await writeFile(path.join(paths.runResults, "agent.log"), result.stderr, "utf8");
  } catch (error) {
    run = errorReport(error);
  }

  hooks.onTaskStart?.({ taskId: task.instanceId, index, total, phase: "grade" });
  console.error(`[${index}/${total}] ${task.instanceId}: grade`);
  let grade: Record<string, unknown>;
  const gradeStartedAt = Date.now();
  try {
    grade = await gradeTask({
      tasks: args.tasks,
      taskId: task.instanceId,
      workspace: paths.workspace,
      results: paths.gradeResults,
      image: args.image,
      python: args.python,
      containerWorkspace: args.containerWorkspace,
      containerResults: args.containerResults,
    });
  } catch (error) {
    grade = errorReport(error);
  }
  const completedAt = Date.now();
  const metrics = taskMetricsFromReport({
    task,
    runtime,
    run,
    grade,
    paths,
    durationMs: {
      workspacePrepare: workspacePreparedAt === undefined ? null : workspacePreparedAt - taskStartedAt,
      workerStartup: workspacePreparedAt === undefined || workerStartedAt === undefined
        ? null
        : workerStartedAt - workspacePreparedAt,
      agent: workerStartedAt === undefined ? null : gradeStartedAt - workerStartedAt,
      grading: completedAt - gradeStartedAt,
      total: completedAt - taskStartedAt,
    },
  });
  await writeFile(
    path.join(path.dirname(paths.runResults), "metrics.json"),
    JSON.stringify(metrics, null, 2),
    "utf8",
  );
  const report = {
    taskId: task.instanceId,
    workspace: paths.workspace,
    runResults: paths.runResults,
    gradeResults: paths.gradeResults,
    run,
    grade,
    metrics,
  };
  hooks.onTaskComplete?.({ taskId: task.instanceId, report });
  return report;
}

export async function runBatch(
  args: BatchTaskArguments,
  hooks: BatchRunHooks = {},
): Promise<Record<string, unknown>> {
  const tasks = await loadTasks(args.tasks);
  if (tasks.length === 0) throw new Error("SWE-bench task 列表为空");
  await mkdir(args.workspaces, { recursive: true });
  await mkdir(args.results, { recursive: true });
  const configuredRuntime = await loadRuntime();
  const runtime = args.maxSteps === undefined
    ? configuredRuntime
    : { ...configuredRuntime, maxSteps: args.maxSteps };
  const taskReports: Record<string, unknown>[] = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const report = await runOneTask(
      tasks[index],
      args,
      runtime,
      index + 1,
      tasks.length,
      hooks,
    );
    taskReports.push(report);
    const grades = taskReports.map((item) => item.grade).filter(
      (grade): grade is Record<string, unknown> => grade !== null && typeof grade === "object",
    );
    await writeFile(
      path.join(args.results, "summary.json"),
      JSON.stringify({ ...summarizeBatchResults(grades, metricsFromReports(taskReports)), tasks: taskReports }, null, 2),
      "utf8",
    );
  }
  const grades = taskReports.map((item) => item.grade).filter(
    (grade): grade is Record<string, unknown> => grade !== null && typeof grade === "object",
  );
  const report = { ...summarizeBatchResults(grades, metricsFromReports(taskReports)), tasks: taskReports };
  await writeFile(
    path.join(args.results, "summary.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  return report;
}

async function main(): Promise<void> {
  const report = await runBatch(parseBatchTaskArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if ((report.resolvedRate as number) < 1) process.exitCode = 1;
}

const isMainModule =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
