import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPiBatchSummary,
  parsePiBatchTaskArguments,
} from "../../scripts/swebench/pi_batch_task.ts";
import type { TaskMetrics } from "../../eval/swebench/metrics.ts";

function metric(taskId: string, resolved: boolean): TaskMetrics {
  return {
    schemaVersion: 1,
    source: "live",
    taskId,
    agent: { id: "pi", provider: "deepseek", model: "deepseek-v4-flash", executionProfile: "direct-provider-egress", stepLimit: null },
    correctness: {
      resolved,
      failToPass: { passed: resolved ? 1 : 0, total: 1 },
      passToPass: { passed: 1, total: 1 },
    },
    durationMs: { workspacePrepare: 1, workerStartup: 2, agent: 3, grading: 4, total: 10 },
    agentBehavior: {
      turns: null, steps: 3, toolCalls: 4, toolCallsByName: { bash: 4 }, toolFailures: 0,
      modelRequests: 3, inputTokens: null, outputTokens: null, totalTokens: 100,
      contextCompactions: 0, filesChanged: null, verificationCommands: 1,
    },
    artifacts: { session: "run/pi-session", agentLog: "run/agent.log", graderLog: "grade/eval.log" },
  };
}

test("Pi 批量 CLI 解析十题运行所需参数和默认值", () => {
  const args = parsePiBatchTaskArguments([
    "--tasks", "/tmp/tasks.json",
    "--repo-root", "/tmp/sympy",
    "--workspaces", "/tmp/workspaces",
    "--results", "/tmp/results",
    "--image", "coding-agent-pi:sympy-env",
    "--python", "/tmp/python",
  ]);
  assert.equal(args.provider, "deepseek");
  assert.equal(args.model, "deepseek-v4-flash");
  assert.equal(args.containerWorkspace, "/testbed");
  assert.equal(args.containerResults, "/results");
});

test("Pi 批量汇总保留十题可比较的正确性和行为指标", () => {
  const first = { taskId: "a", grade: { resolved: true }, metrics: metric("a", true) };
  const second = { taskId: "b", grade: { resolved: false }, metrics: metric("b", false) };

  const summary = buildPiBatchSummary([first, second]);

  assert.equal(summary.taskCount, 2);
  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.metrics.totalTokens, 200);
  assert.equal(summary.tasks.length, 2);
});
