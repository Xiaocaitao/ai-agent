import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FileChange } from "../../file_change_tracker.ts";
import { ReActAgent } from "../../runtime/agent.ts";
import type { ResponsesClient } from "../../runtime/responses.ts";
import type { TokenUsage } from "../../runtime/usage.ts";
import { SessionStore } from "../../session/store.ts";
import { initializeStateDatabase } from "../../sqlite.ts";
import { configureWorkspace } from "../../tools/_common.ts";
import { loadTools } from "../../tools/registry.ts";
import {
  configureCommandExecutor,
  resetCommandExecutor,
} from "../../tools/run_command.ts";
import { createContainerCommandExecutor } from "./container_executor.ts";
import { createStdioResponsesClient } from "./model_proxy.ts";
import type { SWEbenchWorkerInput } from "./types.ts";
import { MAX_EVAL_STEPS } from "./limits.ts";

export type DockerWorkerOptions = {
  agentRoot: string;
  workspace: string;
  model: string;
  systemPrompt: string;
  maxSteps: number;
  contextWindow?: number;
  client: ResponsesClient;
  stateDatabasePath?: string;
  output?: (line: string) => void;
};

export type DockerWorkerResult = {
  taskId: string;
  answer: string;
  tokenUsage: TokenUsage;
  fileChanges: FileChange[];
};

export class DockerWorkerError extends Error {
  readonly tokenUsage: TokenUsage;
  readonly fileChanges: FileChange[];

  constructor(
    message: string,
    tokenUsage: TokenUsage,
    fileChanges: FileChange[],
  ) {
    super(message);
    this.name = "DockerWorkerError";
    this.tokenUsage = tokenUsage;
    this.fileChanges = fileChanges;
  }
}

function validateInput(input: SWEbenchWorkerInput): void {
  if (typeof input.taskId !== "string" || !input.taskId.trim()) {
    throw new Error("taskId 不能为空");
  }
  if (
    typeof input.problemStatement !== "string" ||
    !input.problemStatement.trim()
  ) {
    throw new Error("problemStatement 不能为空");
  }
}

export function parseWorkerInput(text: string): SWEbenchWorkerInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Worker stdin 不是合法 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker 输入必须是 JSON 对象");
  }
  const input = value as Partial<SWEbenchWorkerInput>;
  validateInput(input as SWEbenchWorkerInput);
  return {
    taskId: input.taskId as string,
    problemStatement: input.problemStatement as string,
  };
}

/**
 * 在 Docker Worker 内运行当前 ReActAgent。
 * 容器内的 ask 权限由 Worker 策略自动批准；危险命令仍由 commandPolicy 拒绝。
 */
export async function runDockerWorker(
  input: SWEbenchWorkerInput,
  options: DockerWorkerOptions,
): Promise<DockerWorkerResult> {
  validateInput(input);
  configureWorkspace(options.workspace);
  configureCommandExecutor(createContainerCommandExecutor());
  const database = await initializeStateDatabase(
    options.stateDatabasePath ?? "/results/session.sqlite",
  );
  let agent: ReActAgent | undefined;
  try {
    const tools = await loadTools(options.agentRoot, async () => "once");
    const sessionStore = new SessionStore(database);
    const session = sessionStore.createSession(
      options.workspace,
      options.model,
      createHash("sha256").update(options.systemPrompt).digest("hex"),
    );
    agent = new ReActAgent(
      options.client,
      options.model,
      options.systemPrompt,
      tools,
      options.maxSteps,
      [],
      sessionStore.recorder(session.id),
      options.contextWindow,
    );
    const answer = await agent.runTurn(
      input.problemStatement,
      options.output ?? (() => undefined),
    );
    return {
      taskId: input.taskId,
      answer,
      tokenUsage: agent.tokenUsage,
      fileChanges: agent.lastTurnFileChanges,
    };
  } catch (error) {
    if (agent === undefined) throw error;
    throw new DockerWorkerError(
      error instanceof Error ? error.message : String(error),
      agent.tokenUsage,
      agent.lastTurnFileChanges,
    );
  } finally {
    database.close();
    resetCommandExecutor();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Worker 环境变量缺失: ${name}`);
  }
  return value;
}

function positiveIntegerEnvironment(name: string, fallback: number, maximum?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new Error(`Worker 环境变量 ${name} 必须是 1-${maximum ?? "正整数"}`);
  }
  return value;
}

async function* inputLines(): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer !== "") yield buffer;
}

/**
 * 容器入口：stdin/stdout 同时承载 task 和模型 IPC。
 * Worker 不打开公网、不读取 API Key；宿主机负责响应 model_request。
 */
export async function runDockerWorkerProcess(): Promise<DockerWorkerResult> {
  const lines = inputLines()[Symbol.asyncIterator]();
  const receive = async (): Promise<string> => {
    const next = await lines.next();
    if (next.done) throw new Error("Worker stdin 在模型响应前结束");
    return next.value;
  };
  const input = parseWorkerInput(await receive());
  const agentRoot = process.env.WORKER_AGENT_ROOT ?? path.resolve(import.meta.dirname, "../..");
  const workspace = process.env.WORKER_WORKSPACE ?? "/workspace";
  const promptFile = requiredEnvironment("WORKER_SYSTEM_PROMPT_FILE");
  const systemPrompt = await readFile(promptFile, "utf8");
  const model = requiredEnvironment("WORKER_MODEL");
  const client = createStdioResponsesClient({
    send: (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    receive,
  });
  const result = await runDockerWorker(input, {
    agentRoot,
    workspace,
    model,
    systemPrompt,
    maxSteps: positiveIntegerEnvironment("WORKER_MAX_STEPS", 10, MAX_EVAL_STEPS),
    contextWindow: positiveIntegerEnvironment("WORKER_CONTEXT_WINDOW", 1_000_000),
    stateDatabasePath: process.env.WORKER_STATE_DATABASE ?? "/results/session.sqlite",
    client,
    output: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  // 一个 Worker 只处理一个 task；结果写出后关闭 stdin，让 docker exec 正常结束。
  process.stdin.destroy();
  return result;
}

if (import.meta.main) {
  runDockerWorkerProcess().catch((error) => {
    if (error instanceof DockerWorkerError) {
      process.stdout.write(`${JSON.stringify({
        type: "worker_error",
        error: error.message,
        tokenUsage: error.tokenUsage,
        fileChanges: error.fileChanges,
      })}\n`);
    }
    process.stderr.write(
      `Worker 失败: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }).finally(() => {
    // 成功路径和异常路径都要关闭 stdin，否则 docker exec -i 会一直等待输入。
    process.stdin.destroy();
  });
}
