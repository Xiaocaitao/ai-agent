import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBatchTaskPaths,
  parseBatchTaskArguments,
  summarizeBatchResults,
} from "../../scripts/swebench/batch_task.ts";
import type { TaskMetrics } from "../../eval/swebench/metrics.ts";

function metric(taskId: string, resolved: boolean): TaskMetrics {
  return {
    schemaVersion: 1,
    source: "live",
    taskId,
    agent: { id: "coding-agent", provider: "deepseek", model: "deepseek-v4-flash", executionProfile: "host-model-proxy" },
    correctness: {
      resolved,
      failToPass: { passed: resolved ? 1 : 0, total: 1 },
      passToPass: { passed: 1, total: 1 },
    },
    durationMs: { workspacePrepare: 1, workerStartup: 2, agent: 3, grading: 4, total: 10 },
    agentBehavior: {
      turns: 1, steps: 2, toolCalls: 3, toolCallsByName: { run_command: 3 }, toolFailures: 0,
      modelRequests: 2, inputTokens: 10, outputTokens: 1, totalTokens: 11,
      contextCompactions: 0, filesChanged: 1, verificationCommands: 1,
    },
    artifacts: { session: "run/session.sqlite", agentLog: "run/agent.log", graderLog: "grade/eval.log" },
  };
}

test("batch CLI 解析参数并设置默认容器路径", () => {
  const args = parseBatchTaskArguments([
    "--tasks", "/tmp/tasks.jsonl",
    "--repo-root", "/tmp/sympy",
    "--workspaces", "/tmp/swebench-workspaces",
    "--results", "/tmp/swebench-results",
    "--image", "coding-agent-worker:sympy-env",
    "--python", "/tmp/swebench-venv/bin/python",
  ]);
  assert.equal(args.containerWorkspace, "/testbed");
  assert.equal(args.containerResults, "/results");
  assert.equal(args.verbose, false);
});

test("batch CLI 为每个 task 生成隔离的 run 和 grade 路径", () => {
  assert.deepEqual(
    buildBatchTaskPaths("/tmp/workspaces", "/tmp/results", "sympy__sympy-20590"),
    {
      workspace: "/tmp/workspaces/sympy__sympy-20590",
      runResults: "/tmp/results/sympy__sympy-20590/run",
      gradeResults: "/tmp/results/sympy__sympy-20590/grade",
    },
  );
});

test("batch 汇总 resolved 和两个正确性指标", () => {
  const summary = summarizeBatchResults([
    { taskId: "a", resolved: true, correctness: { failToPass: 1, passToPass: 1 } },
    { taskId: "b", resolved: false, correctness: { failToPass: 0, passToPass: 1 } },
  ]);
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.resolvedRate, 0.5);
  assert.equal(summary.averageFailToPass, 0.5);
  assert.equal(summary.averagePassToPass, 1);
});

test("batch 汇总保留统一指标，便于同一批次比较 Agent", () => {
  const summary = summarizeBatchResults([], [metric("a", true), metric("b", false)]);
  assert.equal(summary.metrics.resolvedCount, 1);
  assert.equal(summary.metrics.totalTokens, 22);
  assert.equal(summary.metrics.totalToolCalls, 6);
});

test("batch CLI 拒绝缺少值", () => {
  assert.throws(
    () => parseBatchTaskArguments(["--tasks"]),
    /参数 --tasks 缺少值/,
  );
});

test("batch CLI 将最大步骤限制为 100", () => {
  assert.throws(
    () => parseBatchTaskArguments([
      "--tasks", "/tmp/tasks.jsonl", "--repo-root", "/tmp/sympy",
      "--workspaces", "/tmp/workspaces", "--results", "/tmp/results",
      "--image", "worker", "--python", "/tmp/python", "--max-steps", "101",
    ]),
    /--max-steps 必须是 1-100 的整数/,
  );
});
