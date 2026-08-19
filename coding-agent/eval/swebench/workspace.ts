import { mkdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import type { SWEbenchTask } from "./task.ts";

export type GitCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type GitCommandRunner = (args: string[]) => Promise<GitCommandResult>;

export type PrepareTaskWorkspaceOptions = {
  repoRoot: string;
  workspace: string;
  task: SWEbenchTask;
  runGit?: GitCommandRunner;
};

function assertAbsolute(value: string, label: string): void {
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须是绝对路径`);
}

async function defaultRunGit(args: string[]): Promise<GitCommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function prepareTaskWorkspace(
  options: PrepareTaskWorkspaceOptions,
): Promise<{ workspace: string; baseCommit: string }> {
  assertAbsolute(options.repoRoot, "repoRoot");
  assertAbsolute(options.workspace, "workspace");
  if (path.resolve(options.repoRoot) === path.resolve(options.workspace)) {
    throw new Error("repoRoot 和 workspace 不能相同");
  }
  const runGit = options.runGit ?? defaultRunGit;
  const verify = await runGit([
    "-C",
    options.repoRoot,
    "rev-parse",
    "--verify",
    `${options.task.baseCommit}^{commit}`,
  ]);
  if (verify.exitCode !== 0) {
    throw new Error(`base commit 不存在: ${verify.stderr.trim() || verify.stdout.trim()}`);
  }
  const expectedCommit = verify.stdout.trim();

  if (await pathExists(options.workspace)) {
    const topLevel = await runGit([
      "-C",
      options.workspace,
      "rev-parse",
      "--show-toplevel",
    ]);
    const head = await runGit(["-C", options.workspace, "rev-parse", "HEAD"]);
    const status = await runGit(["-C", options.workspace, "status", "--porcelain"]);
    const requestedWorkspace = await realpath(options.workspace);
    const reusable =
      topLevel.exitCode === 0 &&
      (await realpath(topLevel.stdout.trim())) === requestedWorkspace &&
      head.exitCode === 0 &&
      head.stdout.trim() === expectedCommit &&
      status.exitCode === 0 &&
      status.stdout.trim() === "";
    if (!reusable) throw new Error("workspace 已存在，拒绝覆盖或复用");
    return {
      workspace: options.workspace,
      baseCommit: options.task.baseCommit,
    };
  }

  await mkdir(path.dirname(options.workspace), { recursive: true });

  const worktree = await runGit([
    "-C",
    options.repoRoot,
    "worktree",
    "add",
    "--detach",
    options.workspace,
    options.task.baseCommit,
  ]);
  if (worktree.exitCode !== 0) {
    throw new Error(`创建 task workspace 失败: ${worktree.stderr.trim() || worktree.stdout.trim()}`);
  }
  return {
    workspace: options.workspace,
    baseCommit: options.task.baseCommit,
  };
}
