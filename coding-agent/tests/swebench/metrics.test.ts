import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildCorrectnessMetrics,
  collectCodingAgentBehavior,
  summarizeMetrics,
  type TaskMetrics,
} from "../../eval/swebench/metrics.ts";
import { initializeStateDatabase } from "../../sqlite.ts";
import { SessionStore } from "../../session/store.ts";

async function createSessionFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "coding-agent-metrics-"));
  const databasePath = path.join(directory, "session.sqlite");
  const database = await initializeStateDatabase(databasePath);
  let now = 1_000;
  let nextId = 0;
  const store = new SessionStore(database, {
    now: () => now++, createId: () => `id-${++nextId}`,
  });
  const session = store.createSession("/testbed", "deepseek-v4-flash", "prompt-hash");
  const recorder = store.recorder(session.id);

  const firstTurn = await recorder.startTurn("fix task");
  await recorder.appendItem!(firstTurn, {
    type: "function_call", call_id: "call-read", name: "read_file", arguments: "{}",
  });
  await recorder.appendItem!(firstTurn, {
    type: "function_call_output", call_id: "call-read", output: "contents",
  });
  await recorder.appendItem!(firstTurn, {
    type: "function_call", call_id: "call-command", name: "run_command", arguments: "{}",
  });
  await recorder.appendItem!(firstTurn, {
    type: "function_call_output", call_id: "call-command", output: "ok",
  });
  await recorder.completeTurn(firstTurn);

  const secondTurn = await recorder.startTurn("verify task");
  await recorder.appendItem!(secondTurn, {
    type: "function_call", call_id: "call-failed", name: "run_command", arguments: "{}",
  });
  await recorder.appendItem!(secondTurn, {
    type: "function_call_output", call_id: "call-failed", output: JSON.stringify({ error: "failed" }),
  });
  await recorder.failTurn(secondTurn, new Error("tool failure"));
  await recorder.saveCompaction!("summary", 1);
  database.close();
  return databasePath;
}

async function createMultiSessionFixture(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "coding-agent-metrics-multi-"));
  const databasePath = path.join(directory, "session.sqlite");
  const database = await initializeStateDatabase(databasePath);
  let now = 10_000;
  let nextId = 0;
  const store = new SessionStore(database, {
    now: () => now++, createId: () => `multi-${++nextId}`,
  });

  const oldSession = store.createSession("/old", "deepseek-v4-flash", "prompt-hash");
  const oldRecorder = store.recorder(oldSession.id);
  const oldTurn = await oldRecorder.startTurn("old task");
  await oldRecorder.appendItem!(oldTurn, {
    type: "function_call", call_id: "old-call", name: "run_command", arguments: "{}",
  });
  await oldRecorder.appendItem!(oldTurn, {
    type: "function_call_output", call_id: "old-call", output: JSON.stringify({ error: "old failure" }),
  });
  await oldRecorder.completeTurn(oldTurn);

  const latestSession = store.createSession("/latest", "deepseek-v4-flash", "prompt-hash");
  const latestRecorder = store.recorder(latestSession.id);
  const latestTurn = await latestRecorder.startTurn("latest task");
  await latestRecorder.appendItem!(latestTurn, {
    id: "reasoning-1",
    type: "reasoning",
    summary: [],
    content: [{ type: "reasoning_text", text: "inspect" }],
  });
  await latestRecorder.appendItem!(latestTurn, {
    type: "function_call", call_id: "latest-call", name: "run_command",
    arguments: JSON.stringify({ command: ["pytest", "tests/test_target.py"] }),
  });
  await latestRecorder.appendItem!(latestTurn, {
    type: "function_call_output", call_id: "latest-call",
    output: JSON.stringify({ error: null, exit_code: 0 }),
  });
  await latestRecorder.completeTurn(latestTurn);
  database.close();
  return databasePath;
}

function taskMetric(overrides: Partial<TaskMetrics> = {}): TaskMetrics {
  return {
    schemaVersion: 1,
    source: "live",
    taskId: "task",
    agent: {
      id: "coding-agent",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      executionProfile: "host-model-proxy",
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
      turns: 1,
      steps: 1,
      toolCalls: 1,
      toolCallsByName: { read_file: 1 },
      toolFailures: 0,
      modelRequests: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      contextCompactions: 0,
      filesChanged: 1,
      verificationCommands: 0,
    },
    artifacts: { session: "run/session.sqlite", agentLog: "run/agent.log", graderLog: "grade/eval.log" },
    ...overrides,
  };
}

test("collectCodingAgentBehavior 统计 session 中的工具、失败、轮次和压缩", async () => {
  const behavior = collectCodingAgentBehavior(await createSessionFixture());

  assert.deepEqual(behavior.toolCallsByName, { read_file: 1, run_command: 2 });
  assert.equal(behavior.toolCalls, 3);
  assert.equal(behavior.toolFailures, 1);
  assert.equal(behavior.turns, 2);
  assert.equal(behavior.steps, 0);
  assert.equal(behavior.modelRequests, 0);
  assert.equal(behavior.contextCompactions, 1);
});

test("collectCodingAgentBehavior 只统计最新 session，并识别 reasoning 和 null error", async () => {
  const behavior = collectCodingAgentBehavior(await createMultiSessionFixture());

  assert.deepEqual(behavior.toolCallsByName, { run_command: 1 });
  assert.equal(behavior.toolCalls, 1);
  assert.equal(behavior.toolFailures, 0);
  assert.equal(behavior.turns, 1);
  assert.equal(behavior.steps, 1);
  assert.equal(behavior.modelRequests, 1);
  assert.equal(behavior.verificationCommands, 1);
});

test("summarizeMetrics 不把不可观测 token 误当作零", () => {
  const known = taskMetric({
    agentBehavior: { ...taskMetric().agentBehavior, totalTokens: 100 },
  });
  const unknown = taskMetric({
    taskId: "other",
    correctness: { resolved: false, failToPass: { passed: 0, total: 1 }, passToPass: { passed: 1, total: 1 } },
  });

  const summary = summarizeMetrics([known, unknown]);

  assert.equal(summary.resolvedCount, 1);
  assert.equal(summary.resolvedRate, 0.5);
  assert.equal(summary.totalTokens, null);
  assert.equal(summary.averageFailToPass, 0.5);
});

test("buildCorrectnessMetrics 优先使用官方成功/失败测试列表", () => {
  const correctness = buildCorrectnessMetrics({
    resolved: false,
    correctness: {
      failToPassTests: { success: ["target"], failure: ["edge"] },
      passToPassTests: { success: ["regression"], failure: [] },
    },
  });

  assert.deepEqual(correctness, {
    resolved: false,
    failToPass: { passed: 1, total: 2 },
    passToPass: { passed: 1, total: 1 },
  });
});
