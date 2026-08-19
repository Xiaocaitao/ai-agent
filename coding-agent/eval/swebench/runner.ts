import { mkdir } from "node:fs/promises";

import type { Runtime } from "../../config.ts";
import {
  DockerSandbox,
  type DockerSandboxOptions,
} from "./docker_sandbox.ts";
import {
  createConfiguredModelProxy,
} from "./provider.ts";
import type { ModelProxyHandler } from "./model_proxy.ts";
import type { SWEbenchWorkerInput, SWEbenchWorkerResult } from "./types.ts";
import type { SWEbenchTask } from "./task.ts";
import { toWorkerInput } from "./task.ts";
import { prepareTaskWorkspace } from "./workspace.ts";

const DEFAULT_WORKER_COMMAND = [
  "node",
  "--experimental-strip-types",
  "eval/swebench/worker.ts",
];

export function buildWorkerEnvironment(
  runtime: Runtime,
  paths: { containerWorkspace?: string; containerResults?: string } = {},
): Record<string, string> {
  const containerWorkspace = paths.containerWorkspace ?? "/workspace";
  const containerResults = paths.containerResults ?? "/results";
  return {
    WORKER_MODEL: runtime.provider.model,
    WORKER_SYSTEM_PROMPT_FILE: "/opt/coding-agent/config/prompts/react.md",
    WORKER_MAX_STEPS: String(runtime.maxSteps),
    WORKER_CONTEXT_WINDOW: String(runtime.provider.context_window),
    WORKER_WORKSPACE: containerWorkspace,
    WORKER_STATE_DATABASE: `${containerResults}/session.sqlite`,
  };
}

export type DockerTaskOptions = {
  runtime: Runtime;
  input: SWEbenchWorkerInput;
  image: string;
  workspace: string;
  resultDirectory: string;
  containerWorkspace?: string;
  containerResults?: string;
  projectRoot?: string;
  workerCommand?: string[];
  modelProxy?: ModelProxyHandler;
  traceOutput?: (line: string) => void;
  onWorkerStarted?: () => void;
  processRunner?: DockerSandboxOptions["processRunner"];
  interactiveRunner?: DockerSandboxOptions["interactiveRunner"];
};

/**
 * 一次性运行一个 SWE-bench Worker，并保证无论成功、失败还是异常都清理容器。
 * runtime/provider 只在宿主机使用，Worker 只收到非敏感环境变量。
 */
export async function runDockerTask(
  options: DockerTaskOptions,
): Promise<SWEbenchWorkerResult> {
  await mkdir(options.resultDirectory, { recursive: true });
  const sandbox = new DockerSandbox({
    image: options.image,
    workspace: options.workspace,
    resultDirectory: options.resultDirectory,
    projectRoot: options.projectRoot,
    workerCommand: options.workerCommand ?? DEFAULT_WORKER_COMMAND,
    containerWorkspace: options.containerWorkspace,
    containerResults: options.containerResults,
    workerEnvironment: buildWorkerEnvironment(options.runtime, options),
    modelProxy: options.modelProxy ?? createConfiguredModelProxy(options.runtime.provider),
    traceOutput: options.traceOutput,
    onWorkerStarted: options.onWorkerStarted,
    processRunner: options.processRunner,
    interactiveRunner: options.interactiveRunner,
  });
  try {
    return await sandbox.runWorker(options.input);
  } finally {
    await sandbox.stop();
  }
}

export type SWEbenchTaskOptions = Omit<DockerTaskOptions, "input"> & {
  task: SWEbenchTask;
  repoRoot: string;
  onWorkspacePrepared?: () => void;
};

/** 准备 base_commit 后运行一个完整 SWE-bench task；workspace 留给调用方清理和 review。 */
export async function runSWEbenchTask(
  options: SWEbenchTaskOptions,
): Promise<SWEbenchWorkerResult> {
  await prepareTaskWorkspace({
    repoRoot: options.repoRoot,
    workspace: options.workspace,
    task: options.task,
  });
  options.onWorkspacePrepared?.();
  return runDockerTask({
    ...options,
    input: toWorkerInput(options.task),
  });
}
