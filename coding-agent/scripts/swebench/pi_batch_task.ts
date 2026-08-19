import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import type { TaskMetrics } from "../../eval/swebench/metrics.ts";
import { loadSWEbenchTasks } from "../../eval/swebench/task.ts";
import {
  buildBatchTaskPaths,
  summarizeBatchResults,
  type BatchResultSummary,
} from "./batch_task.ts";

export type PiBatchTaskArguments = {
  tasks: string;
  repoRoot: string;
  workspaces: string;
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

const FLAGS: Record<string, keyof PiBatchTaskArguments> = {
  "--tasks": "tasks",
  "--repo-root": "repoRoot",
  "--workspaces": "workspaces",
  "--results": "results",
  "--image": "image",
  "--python": "python",
  "--container-workspace": "containerWorkspace",
  "--container-results": "containerResults",
  "--provider": "provider",
  "--model": "model",
  "--pi-command": "piCommand",
};
const REQUIRED = ["--tasks", "--repo-root", "--workspaces", "--results", "--image", "--python"];

export function parsePiBatchTaskArguments(values: string[]): PiBatchTaskArguments {
  const result: Partial<PiBatchTaskArguments> = {
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
    (result as Record<keyof PiBatchTaskArguments, unknown>)[key] = next;
    index += 1;
  }
  for (const flag of REQUIRED) {
    const key = FLAGS[flag];
    if (result[key] === undefined || result[key] === "") throw new Error(`缺少参数: ${flag}`);
  }
  return result as PiBatchTaskArguments;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function metricsFromReports(reports: Record<string, unknown>[]): TaskMetrics[] {
  return reports.map((report) => report.metrics).filter(
    (metric): metric is TaskMetrics => record(metric) !== undefined,
  );
}

export function buildPiBatchSummary(
  reports: Record<string, unknown>[],
): BatchResultSummary & { tasks: Record<string, unknown>[] } {
  const grades = reports.map((report) => record(report.grade) ?? { resolved: false });
  return { ...summarizeBatchResults(grades, metricsFromReports(reports)), tasks: reports };
}

function runChild(args: string[], verbose: boolean): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      stdio: verbose ? "inherit" : ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    if (!verbose) child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && stderr.trim() !== "") console.error(stderr.trim());
      resolve(code);
    });
  });
}

async function loadTaskReport(taskRoot: string, taskId: string, exitCode: number | null): Promise<Record<string, unknown>> {
  try {
    const summary: unknown = JSON.parse(await readFile(path.join(taskRoot, "summary.json"), "utf8"));
    const tasks = record(summary)?.tasks;
    if (Array.isArray(tasks) && tasks.length === 1 && record(tasks[0]) !== undefined) {
      return tasks[0] as Record<string, unknown>;
    }
  } catch { /* 单题启动错误仍写入批量记录，并继续下一题。 */ }
  return {
    taskId,
    run: { status: "error", exitCode, error: "Pi 单题执行未生成 summary.json" },
    grade: { resolved: false },
  };
}

async function main(): Promise<void> {
  const args = parsePiBatchTaskArguments(process.argv.slice(2));
  const tasks = await loadSWEbenchTasks(args.tasks);
  if (tasks.length === 0) throw new Error("SWE-bench task 列表为空");
  await mkdir(args.workspaces, { recursive: true });
  await mkdir(args.results, { recursive: true });
  const startedAt = Date.now();
  const reports: Record<string, unknown>[] = [];

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const paths = buildBatchTaskPaths(args.workspaces, args.results, task.instanceId);
    console.error(`[${index + 1}/${tasks.length}] ${task.instanceId}: Pi run + grade`);
    const childArgs = [
      "--experimental-strip-types",
      "scripts/swebench/pi_task.ts",
      "--tasks", args.tasks,
      "--task-id", task.instanceId,
      "--repo-root", args.repoRoot,
      "--workspace", paths.workspace,
      "--results", path.dirname(paths.runResults),
      "--image", args.image,
      "--python", args.python,
      "--container-workspace", args.containerWorkspace,
      "--container-results", args.containerResults,
      "--provider", args.provider,
      "--model", args.model,
      "--pi-command", args.piCommand,
    ];
    if (args.verbose) childArgs.push("--verbose");
    const exitCode = await runChild(childArgs, args.verbose);
    reports.push(await loadTaskReport(path.dirname(paths.runResults), task.instanceId, exitCode));
    await writeFile(
      path.join(args.results, "summary.json"),
      JSON.stringify(buildPiBatchSummary(reports), null, 2),
      "utf8",
    );
  }

  const completedAt = Date.now();
  const summary = buildPiBatchSummary(reports);
  const metadata = {
    runId: path.basename(path.resolve(args.results)),
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
  await writeFile(path.join(args.results, "run.json"), JSON.stringify(metadata, null, 2), "utf8");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.resolvedRate < 1) process.exitCode = 1;
}

const isMainModule = import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
