import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { initializeStateDatabase } from "../../sqlite.ts";
import { EvaluationStore, assertSafeSegment } from "../../eval/ui/store.ts";

test("评测记录读取器列出 summary，并读取 session 消息", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ui-store-"));
  const taskDir = path.join(root, "run-a", "sympy__sympy-1", "run");
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(root, "run-a", "run.json"), JSON.stringify({
    runId: "run-a", status: "completed", createdAt: "2026-08-16T00:00:00.000Z",
  }));
  await writeFile(path.join(root, "run-a", "summary.json"), JSON.stringify({
    taskCount: 1, resolvedCount: 1, resolvedRate: 1,
    tasks: [{ taskId: "sympy__sympy-1", grade: { resolved: true } }],
  }));
  const database = await initializeStateDatabase(path.join(taskDir, "session.sqlite"));
  database.prepare("INSERT INTO sessions (id, workspace_path, created_at, updated_at, last_model, system_prompt_hash) VALUES (?, ?, ?, ?, ?, ?)").run("session-1", "/testbed", 1, 2, "model", "hash");
  database.prepare("INSERT INTO turns (id, session_id, sequence, user_input, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("turn-1", "session-1", 1, "fix it", "completed", 1, 2);
  database.prepare("INSERT INTO messages (session_id, turn_id, sequence, role, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("session-1", "turn-1", 1, "user", JSON.stringify({ type: "message", role: "user", content: "fix it" }), 1);
  database.prepare("INSERT INTO compactions (session_id, summary, through_turn_sequence, updated_at) VALUES (?, ?, ?, ?)").run("session-1", "保留目标和失败信息", 1, 3);
  database.close();

  const store = new EvaluationStore();
  const runs = await store.listRuns(root);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].summary?.resolvedRate, 1);
  const session = await store.getTaskSession(root, "run-a", "sympy__sympy-1");
  assert.equal(session.session?.id, "session-1");
  assert.equal(session.messages.length, 1);
  assert.equal(session.compactions.length, 1);
  assert.equal(session.compactions[0].through_turn_sequence, 1);
  assert.equal((session.messages[0].payload as Record<string, unknown>).type, "message");
  const agentLog = await store.getTaskLog(root, "run-a", "sympy__sympy-1", "agent");
  assert.match(agentLog.text, /\[user\] fix it/);
});

test("记录路径段拒绝路径穿越", () => {
  assert.throws(() => assertSafeSegment("../secret", "runId"), /非法/);
  assert.throws(() => assertSafeSegment("a/b", "taskId"), /非法/);
});

test("评测记录读取器为旧 Coding Agent 结果补充 session 行为指标", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ui-legacy-metrics-"));
  const taskId = "sympy__sympy-1";
  const taskRunDir = path.join(root, "run-a", taskId, "run");
  await mkdir(taskRunDir, { recursive: true });
  await writeFile(path.join(root, "run-a", "summary.json"), JSON.stringify({
    taskCount: 1,
    tasks: [{ taskId, run: { tokenUsage: { totalTokens: 42 } }, grade: { resolved: false } }],
  }));
  const database = await initializeStateDatabase(path.join(taskRunDir, "session.sqlite"));
  database.prepare("INSERT INTO sessions (id, workspace_path, created_at, updated_at, last_model, system_prompt_hash) VALUES (?, ?, ?, ?, ?, ?)").run("session-1", "/testbed", 1, 2, "model", "hash");
  database.prepare("INSERT INTO turns (id, session_id, sequence, user_input, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("turn-1", "session-1", 1, "fix it", "completed", 1, 2);
  database.prepare("INSERT INTO messages (session_id, turn_id, sequence, role, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("session-1", "turn-1", 1, "assistant", JSON.stringify({ type: "reasoning", text: "inspect" }), 1);
  database.prepare("INSERT INTO messages (session_id, turn_id, sequence, role, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)").run("session-1", "turn-1", 2, "assistant", JSON.stringify({ type: "function_call", name: "read_file", arguments: "{}" }), 2);
  database.close();

  const run = await new EvaluationStore().getRun(root, "run-a");
  const behavior = (run?.summary?.tasks as Array<Record<string, unknown>>)[0].metrics as Record<string, unknown>;
  assert.equal((behavior.agentBehavior as Record<string, unknown>).toolCalls, 1);
  assert.equal((behavior.agentBehavior as Record<string, unknown>).steps, 1);
  assert.equal((behavior.agentBehavior as Record<string, unknown>).totalTokens, 42);
});
