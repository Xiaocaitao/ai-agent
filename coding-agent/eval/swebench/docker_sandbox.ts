import { spawn } from "node:child_process";
import path from "node:path";

import type {
  SWEbenchWorkerInput,
  SWEbenchWorkerResult,
} from "./types.ts";
import type { ModelProxyHandler } from "./model_proxy.ts";

// docker命令的执行结果
export type DockerProcessResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
};

// docker命令执行器
export type DockerProcessRunner = (
  executable: string, // docker
  args: string[], // 执行的命令比如["run","--rm","mt-image"]
  options?: { stdin?: string; timeoutSeconds?: number },
) => Promise<DockerProcessResult>;

export type DockerInteractiveProcess = {
  write(value: string): void;
  end(): void;
  done: Promise<DockerProcessResult>;
};

export type DockerInteractiveRunner = (
  executable: string,
  args: string[],
  onStdoutLine: (line: string) => Promise<void> | void,
  onStderrLine?: (line: string) => void,
) => DockerInteractiveProcess;

export type DockerExtraMount = {
  source: string;
  target: string;
  readonly?: boolean;
};

function splitLines(onLine: (line: string) => Promise<void> | void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void onLine(line);
      newline = buffer.indexOf("\n");
    }
  };
}

const defaultInteractiveRunner: DockerInteractiveRunner = (
  executable,
  args,
  onStdoutLine,
  onStderrLine,
) => {
  const child = spawn(executable, args, { shell: false });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  const stdoutLines = splitLines(onStdoutLine);
  const stderrLines = splitLines((line) => onStderrLine?.(line));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout.push(Buffer.from(chunk));
    stdoutLines(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr.push(Buffer.from(chunk));
    stderrLines(chunk);
  });
  const done = new Promise<DockerProcessResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode: timedOut ? null : exitCode,
      timedOut,
    }));
  });
  return {
    write: (value) => child.stdin.write(value),
    end: () => child.stdin.end(),
    done,
  };
};

// 沙盒所需要的配置
export type DockerSandboxOptions = {
  image: string; // 要启动的Docker镜像
  workspace: string; // 宿主机工作目录
  resultDirectory: string; // 宿主机上保存结果的目录
  workerCommand: string[]; // 容器内要执行的Worker命令和参数
  containerWorkspace?: string; // 容器内 task workspace，官方 SWE-bench 通常是 /testbed
  containerResults?: string; // 容器内结果目录
  workerCwd?: string; // Worker 命令的容器内工作目录，避免经 shell cd
  projectRoot?: string; // 可选的项目根目录
  processRunner?: DockerProcessRunner; // 可选的命令执行器
  interactiveRunner?: DockerInteractiveRunner; // 可选的双向 docker exec 执行器
  modelProxy?: ModelProxyHandler; // 宿主机模型代理处理器
  workerEnvironment?: Record<string, string>; // 只允许非敏感 Worker 配置
  /** 默认断网；只有明确需要直连模型的第三方 Agent 可使用 bridge。 */
  network?: "none" | "bridge";
  /** 仅透传 Docker 从宿主机读取的凭据名称，绝不把凭据值写进 argv。 */
  passthroughEnvironment?: string[];
  onWorkerStarted?: () => void;
  traceOutput?: (line: string) => void; // 实时转发 Worker stderr
  extraMounts?: DockerExtraMount[]; // 仅 grader 等非 Worker 场景使用
};

// 记录容器启动状态
type StartedWorker = {
  containerId: string; // 容器ID
  containerWorkspace: string; // 容器那工作目录
  resultDirectory: string; // 容器内结果目录
};

const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_RESULTS = "/results";
const PASSTHROUGH_ENVIRONMENT = new Set(["DEEPSEEK_API_KEY"]);

// 绝对路径检查
function assertAbsoluteDirectory(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label}必须是绝对路径`);
}

function validateOptions(options: DockerSandboxOptions): void {
  if (!options.image.trim()) throw new Error("Docker image 不能为空");
  if (!Array.isArray(options.workerCommand) || options.workerCommand.length === 0) {
    throw new Error("Worker command 不能为空");
  }
  for (const name of Object.keys(options.workerEnvironment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Worker 环境变量名非法: ${name}`);
    }
    if (/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) {
      throw new Error(`Worker 环境变量不能传入凭据: ${name}`);
    }
  }
  if (options.network !== undefined && options.network !== "none" && options.network !== "bridge") {
    throw new Error("network 只能是 none 或 bridge");
  }
  for (const name of options.passthroughEnvironment ?? []) {
    if (!PASSTHROUGH_ENVIRONMENT.has(name)) {
      throw new Error(`不允许透传环境变量: ${name}`);
    }
  }
  assertAbsoluteDirectory(options.workspace, "workspace");
  assertAbsoluteDirectory(options.resultDirectory, "resultDirectory");
  assertAbsoluteDirectory(options.containerWorkspace ?? CONTAINER_WORKSPACE, "containerWorkspace");
  assertAbsoluteDirectory(options.containerResults ?? CONTAINER_RESULTS, "containerResults");
  if (options.workerCwd !== undefined) assertAbsoluteDirectory(options.workerCwd, "workerCwd");
  for (const mount of options.extraMounts ?? []) {
    assertAbsoluteDirectory(mount.source, "extraMount source");
    assertAbsoluteDirectory(mount.target, "extraMount target");
  }
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
export function buildWorkerContainerStartArgs(options: DockerSandboxOptions): string[] {
  validateOptions(options);
  const containerWorkspace = options.containerWorkspace ?? CONTAINER_WORKSPACE;
  const containerResults = options.containerResults ?? CONTAINER_RESULTS;
  const args = [
    "run",
    "--rm",
    "--detach",
    "--network",
    options.network ?? "none",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--mount",
    `type=bind,src=${options.workspace},dst=${containerWorkspace}`,
    "--mount",
    `type=bind,src=${options.resultDirectory},dst=${containerResults}`,
  ];
  for (const mount of options.extraMounts ?? []) {
    args.push(
      "--mount",
      `type=bind,src=${mount.source},dst=${mount.target}${mount.readonly === true ? ",readonly" : ""}`,
    );
  }
  for (const [name, value] of Object.entries(options.workerEnvironment ?? {})) {
    args.push("--env", `${name}=${value}`);
  }
  for (const name of options.passthroughEnvironment ?? []) {
    args.push("--env", name);
  }
  args.push(options.image, "sleep", "infinity");
  return args;
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
      buildWorkerContainerStartArgs(this.options),
      { timeoutSeconds: 60 },
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Worker 容器启动失败: ${result.stderr || result.stdout}`.trim());
    }
    const containerId = result.stdout.trim().split("\n")[0] ?? "";
    if (!containerId) throw new Error("Worker 容器启动后未返回 container id");
    this.started = {
      containerId,
      containerWorkspace: this.options.containerWorkspace ?? CONTAINER_WORKSPACE,
      resultDirectory: this.options.containerResults ?? CONTAINER_RESULTS,
    };
    this.options.onWorkerStarted?.();
    return this.started;
  }

  async runWorker(input?: SWEbenchWorkerInput): Promise<SWEbenchWorkerResult> {
    const worker = await this.start();
    const execArguments = [
      "exec",
      "-i",
      ...(this.options.workerCwd === undefined ? [] : ["--workdir", this.options.workerCwd]),
      worker.containerId,
      ...this.options.workerCommand,
    ];
    if (this.options.modelProxy !== undefined) {
      if (input === undefined) throw new Error("使用模型代理的 Worker 必须提供输入");
      const modelProxy = this.options.modelProxy;
      const interactiveRunner = this.options.interactiveRunner ?? defaultInteractiveRunner;
      let process: DockerInteractiveProcess | undefined;
      const handleLine = async (line: string): Promise<void> => {
        if (line.trim() === "") return;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (
          message === null ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          (message as Record<string, unknown>).type !== "model_request"
        ) return;
        const request = (message as Record<string, unknown>).request;
        if (
          request === null ||
          typeof request !== "object" ||
          Array.isArray(request) ||
          process === undefined
        ) return;
        try {
          const response = await modelProxy(
            request as Record<string, unknown>,
          );
          process.write(`${JSON.stringify({ type: "model_response", ok: true, response })}\n`);
        } catch (error) {
          process.write(`${JSON.stringify({
            type: "model_response",
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        }
      };
      process = interactiveRunner(
        "docker",
        execArguments,
        handleLine,
        this.options.traceOutput,
      );
      process.write(`${JSON.stringify(input)}\n`);
      const result = await process.done;
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut === true,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    const result = await this.processRunner(
      "docker",
      execArguments,
      {
        stdin: input === undefined ? undefined : `${JSON.stringify(input)}\n`,
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
