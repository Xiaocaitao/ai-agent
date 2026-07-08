import assert from "node:assert/strict";
import test from "node:test";

import { ReActAgent, sanitizeUnicode } from "../runtime.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { ToolHandler } from "../tools/registry.ts";

function message(
  content: string | null = null,
  toolCalls: ReturnType<typeof toolCall>[] = [],
) {
  return { content, tool_calls: toolCalls };
}

function toolCall(
  name = "echo",
  argumentsValue = '{"text":"hello"}',
  id = "call-1",
) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: argumentsValue },
  };
}

const echoSpecs = [{
  type: "function" as const,
  function: { name: "echo", parameters: { type: "object" } },
}];

function fakeClient(...messages: ReturnType<typeof message>[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (request: unknown) => {
            calls.push(request);
            return { choices: [{ message: messages.shift()! }] };
          },
        },
      },
    },
  };
}

test("sanitizeUnicode 清洗嵌套的孤立代理项", () => {
  assert.deepEqual(
    sanitizeUnicode({ emoji: "\ud83d\ude0a", broken: ["\ud83d", "中文✅"] }),
    { emoji: "😊", broken: ["�", "中文✅"] },
  );
});

test("ReActAgent 无工具调用时返回最终回答", async () => {
  const { client, calls } = fakeClient(message("done"));
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
  );
  assert.equal(await agent.runTurn("hello", () => undefined), "done");
  assert.equal("tools" in (calls[0] as object), false);
  assert.equal(agent.messages.at(-1)?.content, "done");
});

test("ReActAgent 执行工具并记录 Observation", async () => {
  const { client } = fakeClient(message(null, [toolCall()]), message("finished"));
  const output: string[] = [];
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry(echoSpecs, {
      echo: ({ text }) => ({ ok: true, data: { text }, error: null }),
    }),
    3,
  );
  assert.equal(
    await agent.runTurn("say hello", output.push.bind(output)),
    "finished",
  );
  assert.deepEqual(agent.messages.map(({ role }) => role), [
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.deepEqual(JSON.parse(String(agent.messages[3]?.content)), {
    ok: true,
    data: { text: "hello" },
    error: null,
  });
  assert.ok(output.some((line) => line.includes("Action:")));
  assert.ok(output.some((line) => line.includes("Observation:")));
});

test("ReActAgent 将工具错误转为 Observation", async () => {
  const cases: Array<{
    call: ReturnType<typeof toolCall>;
    handlers: Record<string, ToolHandler>;
    expected: string;
  }> = [
    { call: toolCall("missing"), handlers: {}, expected: "未注册工具" },
    {
      call: toolCall("echo", "{"),
      handlers: { echo: () => "ok" },
      expected: "参数不是合法 JSON",
    },
    {
      call: toolCall(),
      handlers: {
        echo: () => {
          throw new Error("boom");
        },
      },
      expected: "工具执行失败",
    },
  ];
  for (const item of cases) {
    const { client } = fakeClient(
      message(null, [item.call]),
      message("recovered"),
    );
    const specs = Object.hasOwn(item.handlers, "echo") ? echoSpecs : [];
    const agent = new ReActAgent(
      client,
      "model-x",
      "prompt",
      new ToolRegistry(specs, item.handlers),
      3,
    );
    assert.equal(await agent.runTurn("run", () => undefined), "recovered");
    assert.match(String(agent.messages[3]?.content), new RegExp(item.expected));
  }
});

test("ReActAgent 达到最大步骤时停止", async () => {
  const { client } = fakeClient(message(null, [toolCall()]));
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry(echoSpecs, { echo: ({ text }) => text }),
    1,
  );
  await assert.rejects(
    () => agent.runTurn("loop", () => undefined),
    /最大步骤/,
  );
});
