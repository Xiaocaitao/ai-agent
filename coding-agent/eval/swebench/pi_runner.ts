import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DockerSandbox,
  type DockerProcessResult,
  type DockerSandboxOptions,
} from "./docker_sandbox.ts";
import type { AgentBehaviorMetrics } from "./metrics.ts";
import type { SWEbenchTask } from "./task.ts";
import { prepareTaskWorkspace } from "./workspace.ts";

const PI_TOOLS = "read,bash,edit,write,grep,find,ls";

export type PiCommandOptions = {
  provider: string;
  model: string;
  command: string;
  sessionDirectory: string;
  problemStatement: string;
};

export type PiRunOptions = {
  task: SWEbenchTask;
  repoRoot: string;
  workspace: string;
  resultDirectory: string;
  image: string;
  containerWorkspace?: string;
  containerResults?: string;
  piCommand?: string;
  provider?: string;
  model?: string;
  projectRoot?: string;
  traceOutput?: (line: string) => void;
  processRunner?: DockerSandboxOptions["processRunner"];
  now?: () => number;
};

export type PiRunResult = DockerProcessResult & {
  durationMs: {
    workspacePrepare: number | null;
    workerStartup: number | null;
    agent: number | null;
    total: number;
  };
  behavior: AgentBehaviorMetrics;
  artifacts: {
    session: string;
    agentLog: string;
    jsonEvents: string;
  };
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumOrNull(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left + right;
}

function verificationCommand(args: unknown): boolean {
  const input = record(args);
  const command = [input?.command, input?.cmd, input?.args]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  return /\b(pytest|test|tox|nox|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle(?:w)?\s+test)\b/i.test(command);
}

function initialPiBehavior(): AgentBehaviorMetrics {
  return {
    turns: null,
    steps: 0,
    toolCalls: 0,
    toolCallsByName: {},
    toolFailures: 0,
    modelRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextCompactions: 0,
    filesChanged: null,
    verificationCommands: 0,
  };
}

/** 只拼 argv，不经 shell，因此 problem_statement 不会变成命令片段。 */
export function buildPiCommand(options: PiCommandOptions): string[] {
  return [
    options.command,
    "--provider", options.provider,
    "--model", options.model,
    "--print",
    "--mode", "json",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools", PI_TOOLS,
    "--session-dir", options.sessionDirectory,
    options.problemStatement,
  ];
}

/** 从 Pi 的 JSON event stream 收集可稳定复查的运行数据。 */
export function parsePiJsonEvents(text: string): AgentBehaviorMetrics {
  const behavior = initialPiBehavior();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event === undefined) continue;
    if (event.type === "turn_start") {
      behavior.steps = (behavior.steps ?? 0) + 1;
    }
    if (event.type === "tool_execution_start") {
      const name = typeof event.toolName === "string" ? event.toolName : "unknown";
      behavior.toolCalls = (behavior.toolCalls ?? 0) + 1;
      const byName = behavior.toolCallsByName ?? {};
      byName[name] = (byName[name] ?? 0) + 1;
      behavior.toolCallsByName = byName;
      if (name === "bash" && verificationCommand(event.args)) {
        behavior.verificationCommands = (behavior.verificationCommands ?? 0) + 1;
      }
    }
    if (event.type === "tool_execution_end" && event.isError === true) {
      behavior.toolFailures = (behavior.toolFailures ?? 0) + 1;
    }
    if (event.type === "compaction_end" && event.aborted !== true && event.result !== undefined) {
      behavior.contextCompactions = (behavior.contextCompactions ?? 0) + 1;
    }
    if (event.type === "message_end") {
      const message = record(event.message);
      if (message?.role !== "assistant") continue;
      behavior.modelRequests = (behavior.modelRequests ?? 0) + 1;
      const usage = record(message.usage);
      const input = numberValue(usage?.inputTokens ?? usage?.input_tokens);
      const output = numberValue(usage?.outputTokens ?? usage?.output_tokens);
      const total = numberValue(usage?.totalTokens ?? usage?.total_tokens);
      behavior.inputTokens = sumOrNull(behavior.inputTokens, input);
      behavior.outputTokens = sumOrNull(behavior.outputTokens, output);
      behavior.totalTokens = sumOrNull(behavior.totalTokens, total);
    }
  }
  return behavior;
}

/**
 * 在独立 Docker Worker 中执行 Pi。Pi 直连 provider，因此仅此 adapter 使用 bridge；
 * key 通过 Docker 的宿主机环境透传，不会进入日志、argv 或结果 JSON。
 */
export async function runPiSWEbenchTask(options: PiRunOptions): Promise<PiRunResult> {
  const containerWorkspace = options.containerWorkspace ?? "/testbed";
  const containerResults = options.containerResults ?? "/results";
  const now = options.now ?? Date.now;
  const taskStartedAt = now();
  await prepareTaskWorkspace({
    repoRoot: options.repoRoot,
    workspace: options.workspace,
    task: options.task,
  });
  const workspacePreparedAt = now();
  await mkdir(options.resultDirectory, { recursive: true });
  const sessionDirectory = path.posix.join(containerResults, "pi-session");
  let workerStartedAt: number | undefined;
  const sandbox = new DockerSandbox({
    image: options.image,
    workspace: options.workspace,
    resultDirectory: options.resultDirectory,
    projectRoot: options.projectRoot,
    workerCwd: containerWorkspace,
    workerCommand: buildPiCommand({
      provider: options.provider ?? "deepseek",
      model: options.model ?? "deepseek-v4-flash",
      command: options.piCommand ?? "/opt/pi/pi-test.sh",
      sessionDirectory,
      problemStatement: options.task.problemStatement,
    }),
    containerWorkspace,
    containerResults,
    network: "bridge",
    passthroughEnvironment: ["DEEPSEEK_API_KEY"],
    traceOutput: options.traceOutput,
    processRunner: options.processRunner,
    onWorkerStarted: () => { workerStartedAt = now(); },
  });
  let process: DockerProcessResult | undefined;
  try {
    process = await sandbox.runWorker();
  } finally {
    await sandbox.stop();
  }
  if (process === undefined) throw new Error("Pi Worker 未返回执行结果");
  const completedAt = now();
  const agentLog = path.join(options.resultDirectory, "agent.log");
  const jsonEvents = path.join(options.resultDirectory, "pi.jsonl");
  await Promise.all([
    writeFile(agentLog, process.stderr, "utf8"),
    writeFile(jsonEvents, process.stdout, "utf8"),
  ]);
  return {
    ...process,
    durationMs: {
      workspacePrepare: workspacePreparedAt - taskStartedAt,
      workerStartup: workerStartedAt === undefined ? null : workerStartedAt - workspacePreparedAt,
      agent: workerStartedAt === undefined ? null : completedAt - workerStartedAt,
      total: completedAt - taskStartedAt,
    },
    behavior: parsePiJsonEvents(process.stdout),
    artifacts: {
      session: path.join(options.resultDirectory, "pi-session"),
      agentLog,
      jsonEvents,
    },
  };
}
