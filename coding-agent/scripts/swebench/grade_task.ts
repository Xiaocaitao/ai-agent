import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  DockerSandbox,
  type DockerProcessResult,
} from "../../eval/swebench/docker_sandbox.ts";
import { loadSWEbenchTasks } from "../../eval/swebench/task.ts";

export type GradeTaskArguments = {
  tasks: string;
  taskId: string;
  workspace: string;
  results: string;
  image: string;
  python: string;
  containerWorkspace: string;
  containerResults: string;
};

const FLAG_TO_KEY: Record<string, keyof GradeTaskArguments> = {
  "--tasks": "tasks",
  "--task-id": "taskId",
  "--workspace": "workspace",
  "--results": "results",
  "--image": "image",
  "--python": "python",
  "--container-workspace": "containerWorkspace",
  "--container-results": "containerResults",
};
const REQUIRED = ["--tasks", "--task-id", "--workspace", "--results", "--image", "--python"];

export function parseGradeTaskArguments(values: string[]): GradeTaskArguments {
  const result: Partial<GradeTaskArguments> = {
    containerWorkspace: "/testbed",
    containerResults: "/results",
  };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!flag.startsWith("--")) throw new Error(`未知参数: ${flag}`);
    const key = FLAG_TO_KEY[flag];
    if (key === undefined) throw new Error(`未知参数: ${flag}`);
    if (seen.has(flag)) throw new Error(`重复参数: ${flag}`);
    const next = values[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`参数 ${flag} 缺少值`);
    }
    seen.add(flag);
    (result as Record<keyof GradeTaskArguments, unknown>)[key] = next;
    index += 1;
  }
  for (const flag of REQUIRED) {
    const key = FLAG_TO_KEY[flag];
    if (result[key] === undefined || result[key] === "") {
      throw new Error(`缺少参数: ${flag}`);
    }
  }
  return result as GradeTaskArguments;
}

function runProcess(executable: string, args: string[]): Promise<DockerProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode,
    }));
  });
}

async function emitOfficialScript(args: GradeTaskArguments, scriptPath: string): Promise<void> {
  const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "official_grade.py");
  const result = await runProcess(args.python, [
    bridge,
    "--tasks",
    args.tasks,
    "--task-id",
    args.taskId,
    "--emit-script",
    scriptPath,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`生成官方 eval script 失败: ${result.stderr || result.stdout}`.trim());
  }
}

export async function gradeTask(args: GradeTaskArguments): Promise<Record<string, unknown>> {
  const task = (await loadSWEbenchTasks(args.tasks)).find((item) => item.instanceId === args.taskId);
  if (task === undefined) throw new Error(`未找到 task: ${args.taskId}`);
  await mkdir(args.results, { recursive: true });
  const scriptPath = path.join(args.results, "eval.sh");
  const logPath = path.join(args.results, "eval.log");
  await emitOfficialScript(args, scriptPath);
  const gitCommonDir = await runProcess("git", [
    "-C",
    args.workspace,
    "rev-parse",
    "--git-common-dir",
  ]);
  if (gitCommonDir.exitCode !== 0 || !gitCommonDir.stdout.trim().startsWith("/")) {
    throw new Error(`候选 workspace 不是可用于 grader 的 Git worktree: ${gitCommonDir.stderr || gitCommonDir.stdout}`.trim());
  }
  const gitMetadataPath = gitCommonDir.stdout.trim();

  const shell = [
    'set +e',
    'bash "$1/eval.sh" > "$1/eval.log" 2>&1',
    "code=$?",
    'cat "$1/eval.log"',
    'exit "$code"',
  ].join("; ");
  const sandbox = new DockerSandbox({
    image: args.image,
    workspace: args.workspace,
    resultDirectory: args.results,
    workerCommand: ["bash", "-c", shell, "grader", args.containerResults],
    containerWorkspace: args.containerWorkspace,
    containerResults: args.containerResults,
    extraMounts: [{ source: gitMetadataPath, target: gitMetadataPath }],
  });
  let result: DockerProcessResult;
  try {
    result = await sandbox.runWorker({ taskId: args.taskId, problemStatement: "official grader" });
  } finally {
    await sandbox.stop();
  }
  await writeFile(logPath, result.stdout, "utf8");
  const bridge = path.join(path.dirname(fileURLToPath(import.meta.url)), "official_grade.py");
  const graded = await runProcess(args.python, [
    bridge,
    "--tasks",
    args.tasks,
    "--task-id",
    args.taskId,
    "--log",
    logPath,
  ]);
  if (graded.exitCode !== 0) {
    throw new Error(`解析官方测试结果失败: ${graded.stderr || graded.stdout}`.trim());
  }
  const report = JSON.parse(graded.stdout.trim()) as Record<string, unknown>;
  return {
    ...report,
    exitCode: result.exitCode,
    logPath,
  };
}

async function main(): Promise<void> {
  const report = await gradeTask(parseGradeTaskArguments(process.argv.slice(2)));
  console.log(JSON.stringify(report, null, 2));
  if (report.resolved !== true) process.exitCode = 1;
}

const isMainModule =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
