import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPiSummary,
  parsePiTaskArguments,
} from "../../scripts/swebench/pi_task.ts";
import type { TaskMetrics } from "../../eval/swebench/metrics.ts";

test("Pi task CLI 解析完整参数并提供 DeepSeek 默认值", () => {
  const args = parsePiTaskArguments([
    "--tasks", "/tmp/tasks.json",
    "--task-id", "sympy__sympy-20590",
    "--repo-root", "/tmp/sympy",
    "--workspace", "/tmp/workspace",
    "--results", "/tmp/results",
    "--image", "coding-agent-pi:sympy-env",
    "--python", "/tmp/python",
  ]);
  assert.equal(args.provider, "deepseek");
  assert.equal(args.model, "deepseek-v4-flash");
  assert.equal(args.containerWorkspace, "/testbed");
  assert.equal(args.containerResults, "/results");
});

test("Pi task CLI 拒绝重复和缺少值参数", () => {
  assert.throws(
    () => parsePiTaskArguments(["--tasks"]),
    /参数 --tasks 缺少值/,
  );
  assert.throws(
    () => parsePiTaskArguments([
      "--tasks", "/tmp/tasks.json", "--tasks", "/tmp/other.json",
      "--task-id", "task", "--repo-root", "/tmp/repo", "--workspace", "/tmp/workspace",
      "--results", "/tmp/results", "--image", "image", "--python", "/tmp/python",
    ]),
    /重复参数: --tasks/,
  );
});

test("Pi 单题结果生成可被评测历史读取的汇总结构", () => {
  const metrics: TaskMetrics = {
    schemaVersion: 1,
    source: "live",
    taskId: "sympy__sympy-20590",
    agent: {
      id: "pi",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      executionProfile: "direct-provider-egress",
      stepLimit: null,
    },
    correctness: {
      resolved: true,
      failToPass: { passed: 1, total: 1 },
      passToPass: { passed: 2, total: 2 },
    },
    durationMs: {
      workspacePrepare: 1,
      workerStartup: 2,
      agent: 3,
      grading: 4,
      total: 10,
    },
    agentBehavior: {
      turns: null,
      steps: 3,
      toolCalls: 4,
      toolCallsByName: { bash: 4 },
      toolFailures: 0,
      modelRequests: null,
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      contextCompactions: 0,
      filesChanged: null,
      verificationCommands: 1,
    },
    artifacts: {
      session: "run/pi-session",
      agentLog: "run/agent.log",
      graderLog: "grade/eval.log",
    },
  };
  const report = { taskId: metrics.taskId, grade: { resolved: true }, metrics };

  const summary = buildPiSummary(report, metrics);

  assert.equal(summary.taskCount, 1);
  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.resolvedRate, 1);
  assert.equal(summary.metrics.totalTokens, 30);
  assert.deepEqual(summary.tasks, [report]);
});
