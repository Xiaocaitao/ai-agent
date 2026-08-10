import { spawn } from "node:child_process";
import path from "node:path";

import type {
  SWEbenchWorkerInput,
  SWEbenchWorkerResult,
} from "./types.ts";

export type DockerProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
};

export type DockerProcessRunner = (
  executable: string,
  args: string[],
  options?: { stdin?: string; timeoutSeconds?: number },
) => Promise<DockerProcessResult>;

export type DockerSandboxOptions = {
  image: string;
  workspace: string;
  resultDirectory: string;
  workerCommand: string[];
  projectRoot?: string;
  processRunner?: DockerProcessRunner;
};

type StartedWorker = {
  containerId: string;
  containerWorkspace: string;
  resultDirectory: string;
};

const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_RESULTS = "/results";

function assertAbsoluteDirectory(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
}

function validateOptions(options: DockerSandboxOptions): void {
  if (!options.image.trim()) throw new Error("Docker image 不能为空");
  if (!Array.isArray(options.workerCommand) || options.workerCommand.length === 0) {
    throw new Error("Worker command 不能为空");
  }
  assertAbsoluteDirectory(options.workspace, "workspace");
  assertAbsoluteDirectory(options.resultDirectory, "resultDirectory");
  if (options.projectRoot !== undefined) {
    assertAbsoluteDirectory(options.projectRoot, "projectRoot");
    if (path.resolve(options.workspace) === path.resolve(options.projectRoot)) {
      throw new Error("workspace不能是项目根目录");
    }
  }
}

/**
 * 生成完整 Worker 容器的 argv。
 * 这里只返回参数，不执行 Docker，便于先做安全边界测试。
 */
export function buildWorkerContainerArgs(options: DockerSandboxOptions): string[] {
  validateOptions(options);
  return [
    "run",
    "--rm",
    "--detach",
    "--network",
    "none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--mount",
    `type=bind,src=${options.workspace},dst=${CONTAINER_WORKSPACE}`,
    "--mount",
    `type=bind,src=${options.resultDirectory},dst=${CONTAINER_RESULTS}`,
    options.image,
    "sleep",
    "infinity",
  ];
}

const defaultProcessRunner: DockerProcessRunner = async (
  executable,
  args,
  options = {},
) =>
  await new Promise<DockerProcessResult>((resolve, reject) => {
    const child = spawn(executable, args, { shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timeout = options.timeoutSeconds === undefined
      ? undefined
      : setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutSeconds * 1000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout !== undefined) clearTimeout(timeout);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: timedOut ? null : exitCode,
        timedOut,
      });
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });

export class DockerSandbox {
  private readonly options: DockerSandboxOptions;
  private readonly processRunner: DockerProcessRunner;
  private started?: StartedWorker;

  constructor(options: DockerSandboxOptions) {
    validateOptions(options);
    this.options = options;
    this.processRunner = options.processRunner ?? defaultProcessRunner;
  }

  async start(): Promise<StartedWorker> {
    if (this.started !== undefined) return this.started;
    const result = await this.processRunner(
      "docker",
      buildWorkerContainerArgs(this.options),
      { timeoutSeconds: 60 },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Worker 容器启动失败: ${result.stderr || result.stdout}`.trim());
    }
    const containerId = result.stdout.trim().split("\n")[0] ?? "";
    if (!containerId) throw new Error("Worker 容器启动后未返回 container id");
    this.started = {
      containerId,
      containerWorkspace: CONTAINER_WORKSPACE,
      resultDirectory: CONTAINER_RESULTS,
    };
    return this.started;
  }

  async runWorker(input: SWEbenchWorkerInput): Promise<SWEbenchWorkerResult> {
    const worker = await this.start();
    const result = await this.processRunner(
      "docker",
      ["exec", "-i", worker.containerId, ...this.options.workerCommand],
      {
        stdin: `${JSON.stringify(input)}\n`,
        timeoutSeconds: 60 * 60,
      },
    );
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async stop(): Promise<void> {
    const worker = this.started;
    this.started = undefined;
    if (worker === undefined) return;
    await this.processRunner(
      "docker",
      ["rm", "--force", worker.containerId],
      { timeoutSeconds: 30 },
    );
  }
}
