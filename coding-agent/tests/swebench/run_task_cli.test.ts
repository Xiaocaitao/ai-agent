import assert from "node:assert/strict";
import test from "node:test";

import {
  parseRunTaskArguments,
  summarizeWorkerResult,
} from "../../scripts/swebench/run_task.ts";

test("run_task CLI 解析完整参数", () => {
  assert.deepEqual(
    parseRunTaskArguments([
      "--tasks",
      "/tmp/tasks.jsonl",
      "--task-id",
      "sympy__sympy-20590",
      "--repo-root",
      "/tmp/repos/sympy",
      "--workspace",
      "/tmp/workspaces/sympy-20590",
      "--results",
      "/tmp/results/sympy-20590",
      "--image",
      "coding-agent-worker:sympy-env",
      "--container-workspace",
      "/testbed",
      "--max-steps",
      "50",
      "--verbose",
    ]),
    {
      tasks: "/tmp/tasks.jsonl",
      taskId: "sympy__sympy-20590",
      repoRoot: "/tmp/repos/sympy",
      workspace: "/tmp/workspaces/sympy-20590",
      results: "/tmp/results/sympy-20590",
      image: "coding-agent-worker:sympy-env",
      containerWorkspace: "/testbed",
      containerResults: "/results",
      maxSteps: 50,
      verbose: true,
    },
  );
});

test("run_task CLI 拒绝缺值和未知参数", () => {
  assert.throws(
    () => parseRunTaskArguments(["--tasks"]),
    /参数 --tasks 缺少值/,
  );
  assert.throws(
    () => parseRunTaskArguments(["--unknown", "value"]),
    /未知参数: --unknown/,
  );
  assert.throws(
    () => parseRunTaskArguments([
      "--tasks",
      "tasks.json",
      "--task-id",
      "task-1",
      "--repo-root",
      "/tmp/repo",
      "--workspace",
      "/tmp/workspace",
      "--results",
      "/tmp/results",
      "--image",
      "worker",
      "--max-steps",
      "0",
    ]),
    /--max-steps 必须是 1-100 的整数/,
  );
  assert.throws(
    () => parseRunTaskArguments([
      "--tasks", "tasks.json", "--task-id", "task-1", "--repo-root", "/tmp/repo",
      "--workspace", "/tmp/workspace", "--results", "/tmp/results", "--image", "worker",
      "--max-steps", "101",
    ]),
    /--max-steps 必须是 1-100 的整数/,
  );
});

test("run_task CLI 从 Worker 最终 JSON 提取 token 和修改摘要", () => {
  assert.deepEqual(
    summarizeWorkerResult({
      stdout: [
        JSON.stringify({ type: "model_request", request: {} }),
        JSON.stringify({
          taskId: "task-1",
          answer: "done",
          tokenUsage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          fileChanges: [{ path: "src/a.py" }],
        }),
      ].join("\n"),
      stderr: "[Step 1/2] → 请求模型\n[Step 1/2] ← 最终回答",
      exitCode: 0,
      timedOut: false,
    }),
    {
      taskId: "task-1",
      status: "completed",
      exitCode: 0,
      timedOut: false,
      answer: "done",
      tokenUsage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      fileChanges: [{ path: "src/a.py" }],
      traceLines: 2,
    },
  );
});

test("run_task CLI 从 Worker 失败消息保留已消耗 token", () => {
  assert.deepEqual(
    summarizeWorkerResult({
      stdout: JSON.stringify({
        type: "worker_error",
        error: "已达到最大步骤数 50",
        tokenUsage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
        fileChanges: [],
      }),
      stderr: "[Step 50/50] ← 工具调用",
      exitCode: 1,
      timedOut: false,
    }),
    {
      taskId: undefined,
      status: "failed",
      exitCode: 1,
      timedOut: false,
      answer: undefined,
      tokenUsage: { inputTokens: 120, outputTokens: 80, totalTokens: 200 },
      fileChanges: [],
      error: "已达到最大步骤数 50",
      traceLines: 1,
    },
  );
});
