import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareTaskWorkspace } from "../../eval/swebench/workspace.ts";
import type { SWEbenchTask } from "../../eval/swebench/task.ts";

const task: SWEbenchTask = {
  instanceId: "sympy__sympy-20590",
  repo: "sympy/sympy",
  baseCommit: "0123456789abcdef0123456789abcdef01234567",
  problemStatement: "Fix it.",
  failToPass: [],
  passToPass: [],
};

test("workspace 准备器先校验 base commit，再创建 detached worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swebench-workspace-"));
  const repoRoot = path.join(root, "repo");
  const workspace = path.join(root, "task");
  await mkdir(repoRoot);
  const calls: string[][] = [];
  const result = await prepareTaskWorkspace({
    repoRoot,
    workspace,
    task,
    runGit: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  });

  assert.deepEqual(result, { workspace, baseCommit: task.baseCommit });
  assert.deepEqual(calls, [
    ["-C", repoRoot, "rev-parse", "--verify", `${task.baseCommit}^{commit}`],
    ["-C", repoRoot, "worktree", "add", "--detach", workspace, task.baseCommit],
  ]);
});

test("workspace 准备器复用干净的目标 base commit worktree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swebench-workspace-"));
  const repoRoot = path.join(root, "repo");
  const workspace = path.join(root, "task");
  await mkdir(repoRoot);
  await mkdir(workspace);

  const calls: string[][] = [];
  const result = await prepareTaskWorkspace({
    repoRoot,
    workspace,
    task,
    runGit: async (args) => {
      calls.push(args);
      if (args[0] === "-C" && args[1] === repoRoot) {
        return { exitCode: 0, stdout: `${task.baseCommit}\n`, stderr: "" };
      }
      if (args[2] === "rev-parse" && args[1] === workspace && args[3] === "--show-toplevel") {
        return { exitCode: 0, stdout: `${workspace}\n`, stderr: "" };
      }
      if (args[2] === "rev-parse" && args[1] === workspace && args[3] === "HEAD") {
        return { exitCode: 0, stdout: `${task.baseCommit}\n`, stderr: "" };
      }
      if (args[2] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: `${task.baseCommit}\n`, stderr: "" };
    },
  });

  assert.deepEqual(result, { workspace, baseCommit: task.baseCommit });
  assert.deepEqual(calls[0], [
    "-C",
    repoRoot,
    "rev-parse",
    "--verify",
    `${task.baseCommit}^{commit}`,
  ]);
  assert.equal(calls.some((args) => args.includes("worktree")), false);
});

test("workspace 准备器拒绝已有的非干净 workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swebench-workspace-"));
  const repoRoot = path.join(root, "repo");
  const workspace = path.join(root, "task");
  await mkdir(repoRoot);
  await mkdir(workspace);

  await assert.rejects(
    prepareTaskWorkspace({
      repoRoot,
      workspace,
      task,
      runGit: async (args) =>
        args[1] === repoRoot
          ? { exitCode: 0, stdout: `${task.baseCommit}\n`, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "not a worktree" },
    }),
    /workspace 已存在，拒绝覆盖或复用/,
  );
});
