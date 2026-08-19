import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";

import { runDockerWorker } from "../../eval/swebench/worker.ts";
import type { ResponsesClient } from "../../runtime/responses.ts";

async function* completedResponse(): AsyncGenerator<ResponseStreamEvent> {
  yield {
    type: "response.completed",
    response: {
      output: [{
        id: "message-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: "worker finished",
          annotations: [],
          logprobs: [],
        }],
      }],
      output_text: "worker finished",
      status: "completed",
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
    sequence_number: 1,
  } as unknown as ResponseStreamEvent;
}

test("Docker Worker 在 Linux/容器执行模式下可以直接运行 ReActAgent", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-agent-worker-"));
  const requests: Record<string, unknown>[] = [];
  const client: ResponsesClient = {
    responses: {
      create: async (request) => {
        requests.push(request);
        return completedResponse();
      },
    },
  };

  const result = await runDockerWorker({
    taskId: "demo-task",
    problemStatement: "修复一个测试问题",
  }, {
    agentRoot: path.resolve(import.meta.dirname, "../.."),
    workspace,
    model: "test-model",
    systemPrompt: "你是测试 Worker",
    maxSteps: 2,
    client,
    stateDatabasePath: path.join(workspace, "session.sqlite"),
  });

  assert.equal(result.taskId, "demo-task");
  assert.equal(result.answer, "worker finished");
  assert.equal(result.tokenUsage.totalTokens, 5);
  assert.equal(requests[0]?.instructions, "你是测试 Worker");

  const database = new DatabaseSync(path.join(workspace, "session.sqlite"));
  try {
    const session = database.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
      count: number;
    };
    const turn = database.prepare(
      "SELECT status FROM turns ORDER BY sequence DESC LIMIT 1",
    ).get() as { status: string };
    assert.equal(session.count, 1);
    assert.equal(turn.status, "completed");
  } finally {
    database.close();
  }
});
