import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseOutputItem } from "openai/resources/responses/responses";

import { ReActAgent } from "../runtime/agent.ts";
import { ToolRegistry } from "../tools/registry.ts";

function outputMessage(text: string, id = "message-1") {
  return {
    id,
    type: "message" as const,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{
      type: "output_text" as const,
      text,
      annotations: [],
      logprobs: [],
    }],
  };
}

function reasoning(id: string, text: string) {
  return {
    id,
    type: "reasoning" as const,
    summary: [],
    content: [{ type: "reasoning_text" as const, text }],
  };
}

function functionCall(id = "call-1") {
  return {
    id: `item-${id}`,
    type: "function_call" as const,
    call_id: id,
    name: "echo",
    arguments: '{"text":"hello"}',
    status: "completed" as const,
  };
}

function response(output: ResponseOutputItem[], outputText = "") {
  return {
    output,
    output_text: outputText,
    status: "completed" as const,
    usage: {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    },
  };
}

function fakeResponsesClient(...responses: ReturnType<typeof response>[]) {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: {
      responses: {
        create: async (request: Record<string, unknown>) => {
          requests.push(request);
          return responses.shift()!;
        },
      },
    },
  };
}

const echoTools = new ToolRegistry([{
  type: "function",
  name: "echo",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  strict: false,
}], {
  echo: ({ text }) => ({ ok: true, text }),
});

test("ReActAgent 使用 Responses instructions 和原生 input items", async () => {
  const { client, requests } = fakeResponsesClient(
    response([outputMessage("done")], "done"),
  );
  const agent = new ReActAgent(client, "model-x", "system prompt", echoTools, 3);

  assert.equal(await agent.runTurn("hello", () => undefined), "done");
  assert.equal(requests[0]?.instructions, "system prompt");
  assert.deepEqual(requests[0]?.input, [
    { type: "message", role: "user", content: "hello" },
  ]);
});

test("调用过工具的 Turn 在后续请求完整保留该 Turn 的 reasoning items", async () => {
  const firstReasoning = reasoning("reasoning-1", "先调用工具");
  const finalReasoning = reasoning("reasoning-2", "整理最终答案");
  const call = functionCall();
  const finalMessage = outputMessage("finished", "message-2");
  const { client, requests } = fakeResponsesClient(
    response([firstReasoning, call]),
    response([finalReasoning, finalMessage], "finished"),
    response([outputMessage("next", "message-3")], "next"),
  );
  const agent = new ReActAgent(client, "model-x", "prompt", echoTools, 3);

  assert.equal(await agent.runTurn("first", () => undefined), "finished");
  assert.equal(await agent.runTurn("second", () => undefined), "next");
  assert.deepEqual(requests[2]?.input, [
    { type: "message", role: "user", content: "first" },
    firstReasoning,
    call,
    {
      type: "function_call_output",
      call_id: "call-1",
      output: '{"ok":true,"text":"hello"}',
    },
    finalReasoning,
    finalMessage,
    { type: "message", role: "user", content: "second" },
  ]);
});

test("未调用工具的 Turn 不把 reasoning item 带到下一轮", async () => {
  const finalMessage = outputMessage("first answer");
  const { client, requests } = fakeResponsesClient(
    response([reasoning("reasoning-1", "普通思考"), finalMessage], "first answer"),
    response([outputMessage("second answer", "message-2")], "second answer"),
  );
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
  );

  await agent.runTurn("first", () => undefined);
  await agent.runTurn("second", () => undefined);
  assert.deepEqual(requests[1]?.input, [
    { type: "message", role: "user", content: "first" },
    finalMessage,
    { type: "message", role: "user", content: "second" },
  ]);
});
