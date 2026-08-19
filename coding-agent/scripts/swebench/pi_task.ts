import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  buildCorrectnessMetrics,
  createTaskMetrics,
  summarizeMetrics,
  type BatchMetricsSummary,
  type TaskMetrics,
} from "../../eval/swebench/metrics.ts";
import { runPiSWEbenchTask } from "../../eval/swebench/pi_runner.ts";
import { loadSWEbenchTasks } from "../../eval/swebench/task.ts";
import { gradeTask } from "./grade_task.ts";

export type PiTaskArguments = {
  tasks: string;
  taskId: string;
  repoRoot: string;
  workspace: string;
  results: string;
  image: string;
  python: string;
  containerWorkspace: string;
  containerResults: string;
  provider: string;
  model: string;
  piCommand: string;
  verbose: boolean;
};

const FLAGS: Record<string, keyof PiTaskArguments> = {
  "--tasks": "tasks",
  "--task-id": "taskId",
  "--repo-root": "repoRoot",
  "--workspace": "workspace",
  "--results": "results",
  "--image": "image",
  "--python": "python",
  "--container-workspace": "containerWorkspace",
  "--container-results": "containerResults",
  "--provider": "provider",
  "--model": "model",
  "--pi-command": "piCommand",
};
const REQUIRED = ["--tasks", "--task-id", "--repo-root", "--workspace", "--results", "--image", "--python"];

export function parsePiTaskArguments(values: string[]): PiTaskArguments {
  const result: Partial<PiTaskArguments> = {
    containerWorkspace: "/testbed",
    containerResults: "/results",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    piCommand: "/opt/pi/pi-test.sh",
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
    const key = FLAGS[flag];
    if (key === undefined) throw new Error(`未知参数: ${flag}`);
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`参数 ${flag} 缺少值`);
    seen.add(flag);
    (result as Record<keyof PiTaskArguments, unknown>)[key] = next;
    index += 1;
  }
  for (const flag of REQUIRED) {
    const key = FLAGS[flag];
    if (result[key] === undefined || result[key] === "") throw new Error(`缺少参数: ${flag}`);
  }
  return result as PiTaskArguments;
}

function errorReport(error: unknown): Record<string, unknown> {
  return { status: "error", error: error instanceof Error ? error.message : String(error) };
}

/** 单题 Pi 基线也遵守批量 summary.json 契约，供历史页面与 AI 分析复用。 */
export function buildPiSummary(
  report: Record<string, unknown>,
  metrics: TaskMetrics,
): BatchMetricsSummary & { metrics: BatchMetricsSummary; tasks: Record<string, unknown>[] } {
  const aggregate = summarizeMetrics([metrics]);
  return {
    ...aggregate,
    metrics: aggregate,
    tasks: [report],
  };
}

async function main(): Promise<void> {
  const args = parsePiTaskArguments(process.argv.slice(2));
  const task = (await loadSWEbenchTasks(args.tasks)).find((item) => item.instanceId === args.taskId);
  if (task === undefined) throw new Error(`未找到 task: ${args.taskId}`);
  await mkdir(args.results, { recursive: true });
  const runResults = path.join(args.results, "run");
  const gradeResults = path.join(args.results, "grade");
  const startedAt = Date.now();
  const run = await runPiSWEbenchTask({
    task,
    repoRoot: args.repoRoot,
    workspace: args.workspace,
    resultDirectory: runResults,
    image: args.image,
    containerWorkspace: args.containerWorkspace,
    containerResults: args.containerResults,
    piCommand: args.piCommand,
    provider: args.provider,
    model: args.model,
    traceOutput: args.verbose ? (line) => console.error(line) : undefined,
  });
  const runReport: Record<string, unknown> = {
    status: run.exitCode === 0 && !run.timedOut ? "completed" : "failed",
    exitCode: run.exitCode,
    timedOut: run.timedOut === true,
    durationMs: run.durationMs,
    behavior: run.behavior,
    artifacts: run.artifacts,
  };
  let grade: Record<string, unknown>;
  const gradeStartedAt = Date.now();
  try {
    grade = await gradeTask({
      tasks: args.tasks,
      taskId: task.instanceId,
      workspace: args.workspace,
      results: gradeResults,
      image: args.image,
      python: args.python,
      containerWorkspace: args.containerWorkspace,
      containerResults: args.containerResults,
    });
  } catch (error) {
    grade = errorReport(error);
  }
  const completedAt = Date.now();
  const metrics = createTaskMetrics({
    schemaVersion: 1,
    source: "live",
    taskId: task.instanceId,
    agent: {
      id: "pi",
      provider: args.provider,
      model: args.model,
      executionProfile: "direct-provider-egress",
      stepLimit: null,
    },
    correctness: buildCorrectnessMetrics(grade, {
      failToPass: task.failToPass.length,
      passToPass: task.passToPass.length,
    }),
    durationMs: {
      ...run.durationMs,
      grading: completedAt - gradeStartedAt,
      total: completedAt - startedAt,
    },
    agentBehavior: run.behavior,
    artifacts: {
      session: "run/pi-session",
      agentLog: "run/agent.log",
      graderLog: "grade/eval.log",
    },
  });
  const report = { taskId: task.instanceId, workspace: args.workspace, runResults, gradeResults, run: runReport, grade, metrics };
  const summary = buildPiSummary(report, metrics);
  const runId = path.basename(path.resolve(args.results));
  const metadata = {
    runId,
    status: "completed",
    createdAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    agent: "pi",
    options: {
      tasks: args.tasks,
      repoRoot: args.repoRoot,
      image: args.image,
      python: args.python,
      provider: args.provider,
      model: args.model,
    },
  };
  await Promise.all([
    writeFile(path.join(args.results, "run.json"), JSON.stringify(metadata, null, 2), "utf8"),
    writeFile(path.join(args.results, "summary.json"), JSON.stringify(summary, null, 2), "utf8"),
    writeFile(path.join(args.results, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8"),
  ]);
  console.log(JSON.stringify(report, null, 2));
  if (grade.resolved !== true) process.exitCode = 1;
}

const isMainModule = import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
