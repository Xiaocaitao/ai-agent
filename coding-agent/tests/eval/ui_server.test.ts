import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEvalServer } from "../../eval/ui/server.ts";

async function withServer<T>(run: (base: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ui-server-"));
  const server = createEvalServer({
    runtimeLoader: async () => ({
      provider: { AGENT_API_KEY: "secret-key", base_url: "https://api.example.test", model: "test-model", context_window: 1000 },
      prompt: "test", maxSteps: 10,
    }),
    batchRunner: async (args, hooks) => {
      hooks?.onTaskStart?.({ taskId: "task-1", index: 1, total: 1, phase: "run" });
      hooks?.onLog?.({ taskId: "task-1", line: "step one" });
      await mkdir(path.join(args.results, "task-1", "run"), { recursive: true });
      await writeFile(path.join(args.results, "summary.json"), JSON.stringify({ taskCount: 1, resolvedCount: 0, resolvedRate: 0, tasks: [] }));
      return { taskCount: 1, resolvedCount: 0, resolvedRate: 0, tasks: [] };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address unavailable");
  try { return await run(`http://127.0.0.1:${address.port}`, root); } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

test("健康检查不返回 provider API key", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body.includes("secret-key"), false);
    assert.match(body, /test-model/);
  });
});

test("健康检查返回持久化评测结果的默认目录", async () => {
  const server = createEvalServer({
    defaultResultsRoot: "/tmp/eval-results",
    runtimeLoader: async () => ({
      provider: { AGENT_API_KEY: "", base_url: "https://api.example.test", model: "test-model", context_window: 1000 },
      prompt: "test", maxSteps: 10,
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health`);
    const body = await response.json() as { defaultResultsRoot?: string };
    assert.equal(body.defaultResultsRoot, "/tmp/eval-results");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("启动评测返回 runId，并通过 SSE 回放事件", async () => {
  await withServer(async (base, root) => {
    const body = {
      tasks: path.join(root, "tasks.json"), repoRoot: root,
      workspaces: path.join(root, "workspaces"), results: path.join(root, "results"),
      image: "worker:test", python: path.join(root, "python"), maxSteps: 3,
    };
    const response = await fetch(`${base}/api/evaluations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await response.json() as { runId: string };
    assert.equal(response.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const events = await fetch(`${base}/api/evaluations/${created.runId}/events`);
    const text = await events.text();
    assert.equal(events.status, 200);
    assert.match(text, /event: task_start/);
    assert.match(text, /step one/);
    assert.match(text, /event: run_complete/);
  });
});
