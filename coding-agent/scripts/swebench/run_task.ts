import { loadRuntime } from "../../config.ts";
import type { DockerProcessResult } from "../../eval/swebench/docker_sandbox.ts";
import { runSWEbenchTask } from "../../eval/swebench/runner.ts";
import { loadSWEbenchTasks } from "../../eval/swebench/task.ts";
import { MAX_EVAL_STEPS } from "../../eval/swebench/limits.ts";
import { fileURLToPath } from "node:url";

export type RunTaskArguments = {
  tasks: string;
  taskId: string;
  repoRoot: string;
  workspace: string;
  results: string;
  image: string;
  containerWorkspace: string;
  containerResults: string;
  maxSteps?: number;
  verbose: boolean;
};

type WorkerPayload = {
  taskId: string;
  answer: string;
  tokenUsage: Record<string, number>;
  fileChanges: unknown[];
};

type WorkerErrorPayload = {
  type: "worker_error";
  error: string;
  tokenUsage: Record<string, number>;
  fileChanges: unknown[];
};

const FLAG_TO_KEY: Record<string, keyof RunTaskArguments> = {
  "--tasks": "tasks",
  "--task-id": "taskId",
  "--repo-root": "repoRoot",
  "--workspace": "workspace",
  "--results": "results",
  "--image": "image",
  "--container-workspace": "containerWorkspace",
  "--container-results": "containerResults",
  "--max-steps": "maxSteps",
};
const REQUIRED = ["--tasks", "--task-id", "--repo-root", "--workspace", "--results", "--image"];

export function parseRunTaskArguments(values: string[]): RunTaskArguments {
  const result: Partial<RunTaskArguments> = {
    containerWorkspace: "/workspace",
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
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    const key = FLAG_TO_KEY[flag];
    if (key === undefined) throw new Error(`未知参数: ${flag}`);
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    seen.add(flag);
    if (key === "maxSteps") {
      const maxSteps = Number(next);
      if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_EVAL_STEPS) {
        throw new Error(`--max-steps 必须是 1-${MAX_EVAL_STEPS} 的整数`);
      }
      result.maxSteps = maxSteps;
    } else {
      (result as Record<keyof RunTaskArguments, unknown>)[key] = next;
    }
    index += 1;
  }
  for (const flag of REQUIRED) {
    const key = FLAG_TO_KEY[flag];
    if (result[key] === undefined || result[key] === "") {
      throw new Error(`缺少参数: ${flag}`);
    }
  }
  return result as RunTaskArguments;
}

function parseWorkerPayload(stdout: string): WorkerPayload | WorkerErrorPayload | undefined {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as Partial<WorkerPayload & WorkerErrorPayload>;
      if (
        value.type === "worker_error" &&
        typeof value.error === "string" &&
        value.tokenUsage !== null &&
        typeof value.tokenUsage === "object"
      ) {
        return value as WorkerErrorPayload;
      }
      if (
        typeof value.taskId === "string" &&
        typeof value.answer === "string" &&
        value.tokenUsage !== null &&
        typeof value.tokenUsage === "object"
      ) {
        return value as WorkerPayload;
      }
    } catch {
      // model_request 和 Worker 日志行不是最终结果，继续找下一行。
    }
  }
  return undefined;
}

export function summarizeWorkerResult(result: DockerProcessResult): Record<string, unknown> {
  const worker = parseWorkerPayload(result.stdout);
  const workerError = worker !== undefined && "error" in worker ? worker : undefined;
  return {
    taskId: worker !== undefined && "taskId" in worker ? worker.taskId : undefined,
    status: result.exitCode === 0 && !result.timedOut ? "completed" : "failed",
    exitCode: result.exitCode,
    timedOut: result.timedOut === true,
    answer: worker !== undefined && "answer" in worker ? worker.answer : undefined,
    tokenUsage: worker?.tokenUsage,
    fileChanges: worker?.fileChanges ?? [],
    ...(workerError === undefined ? {} : { error: workerError.error }),
    traceLines: result.stderr.trim() === "" ? 0 : result.stderr.trim().split(/\r?\n/).length,
  };
}

async function main(): Promise<void> {
  const argumentsValue = parseRunTaskArguments(process.argv.slice(2));
  const tasks = await loadSWEbenchTasks(argumentsValue.tasks);
  const task = tasks.find((item) => item.instanceId === argumentsValue.taskId);
  if (task === undefined) throw new Error(`未找到 task: ${argumentsValue.taskId}`);
  const configuredRuntime = await loadRuntime();
  const runtime = argumentsValue.maxSteps === undefined
    ? configuredRuntime
    : { ...configuredRuntime, maxSteps: argumentsValue.maxSteps };
  const result = await runSWEbenchTask({
    runtime,
    task,
    repoRoot: argumentsValue.repoRoot,
    workspace: argumentsValue.workspace,
    resultDirectory: argumentsValue.results,
    image: argumentsValue.image,
    containerWorkspace: argumentsValue.containerWorkspace,
    containerResults: argumentsValue.containerResults,
    traceOutput: argumentsValue.verbose ? (line) => console.error(line) : undefined,
  });
  console.log(JSON.stringify(summarizeWorkerResult(result), null, 2));
  if (result.exitCode !== 0) process.exitCode = 1;
}

const isMainModule =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
