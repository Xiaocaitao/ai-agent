import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createEvalServer } from "../../eval/ui/server.ts";
import type { ResponsesClient } from "../../runtime/responses.ts";

test("AI 分析 API 将 provider 增量转成 SSE，并隐藏凭据", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ui-analysis-"));
  const runDir = path.join(root, "run-1");
  await mkdir(runDir, { recursive: true });
  const taskFile = path.join(root, "tasks.json");
  await writeFile(taskFile, JSON.stringify({ instance_id: "task-1", repo: "org/repo", base_commit: "abc", problem_statement: "修复 sign 的 Abs 重写行为", FAIL_TO_PASS: [], PASS_TO_PASS: [] }));
  await writeFile(path.join(runDir, "run.json"), JSON.stringify({ runId: "run-1", status: "completed", options: { tasks: taskFile } }));
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify({ taskCount: 1, resolvedCount: 0, resolvedRate: 0, tasks: [{ taskId: "task-1", run: { status: "completed" }, grade: { resolved: false, correctness: { failToPass: 0, passToPass: 1 } } }] }));
  const client: ResponsesClient = {
    responses: {
      async create(request) {
        assert.equal(request.stream, true);
        assert.equal(request.max_output_tokens, 393_216);
        assert.equal(JSON.stringify(request).includes("secret-key"), false);
        assert.match(String(request.input), /SYSTEM_RULES/);
        assert.match(String(request.input), /修复 sign 的 Abs 重写行为/);
        return (async function* () {
          yield { type: "response.reasoning_text.delta", delta: "先检查失败测试。", sequence_number: 0 } as never;
          yield { type: "response.output_text.delta", delta: "## 结论\n", sequence_number: 1 } as never;
          yield { type: "response.output_text.delta", delta: "需要修复。", sequence_number: 2 } as never;
          yield { type: "response.completed", response: { output: [], status: "completed" }, sequence_number: 3 } as never;
        })();
      },
    },
  };
  const server = createEvalServer({
    runtimeLoader: async () => ({ provider: { AGENT_API_KEY: "secret-key", base_url: "https://example.test", model: "model", context_window: 1000 }, prompt: "SYSTEM_RULES", maxSteps: 1 }),
    analysisClientFactory: () => client,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/evaluations/run-1/analyze?resultsRoot=${encodeURIComponent(root)}`, { method: "POST" });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /event: start/);
    assert.match(body, /event: delta/);
    assert.match(body, /reasoning_delta/);
    assert.match(body, /先检查失败测试/);
    assert.match(body, /需要修复/);
    assert.match(body, /event: done/);
    assert.equal(body.includes("secret-key"), false);

    const taskResponse = await fetch(`http://127.0.0.1:${address.port}/api/evaluations/run-1/tasks/task-1/analyze?resultsRoot=${encodeURIComponent(root)}`, { method: "POST" });
    const taskBody = await taskResponse.text();
    assert.equal(taskResponse.status, 200);
    assert.match(taskBody, /需要修复/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("AI 分析遇到 provider incomplete 时返回明确错误", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eval-ui-analysis-incomplete-"));
  const runDir = path.join(root, "run-1");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "run.json"), JSON.stringify({ runId: "run-1", status: "completed" }));
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify({ tasks: [{ taskId: "task-1", run: {}, grade: {} }] }));
  const client: ResponsesClient = {
    responses: {
      async create() {
        return (async function* () {
          yield { type: "response.incomplete", response: { output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, sequence_number: 1 } as never;
        })();
      },
    },
  };
  const server = createEvalServer({
    runtimeLoader: async () => ({ provider: { AGENT_API_KEY: "key", base_url: "https://example.test", model: "model", context_window: 1000 }, prompt: "", maxSteps: 1 }),
    analysisClientFactory: () => client,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server address unavailable");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/evaluations/run-1/analyze?resultsRoot=${encodeURIComponent(root)}`, { method: "POST" });
    const body = await response.text();
    assert.match(body, /分析响应不完整/);
    assert.match(body, /max_output_tokens/);
    assert.doesNotMatch(body, /event: done/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
