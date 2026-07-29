import assert from "node:assert/strict";
import test from "node:test";

import { ReActAgent, sanitizeUnicode } from "../runtime.ts";
import type { AgentMessage, SessionRecorder } from "../runtime.ts";
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

test("ReActAgent 按顺序记录无工具的成功 Turn", async () => {
  const events: unknown[] = [];
  const recorder: SessionRecorder = {
    startTurn: async (userInput) => {
      events.push(["start", userInput]);
      return "turn-1";
    },
    appendMessage: async (turnId, value) => {
      events.push(["message", turnId, value]);
    },
    completeTurn: async (turnId) => {
      events.push(["complete", turnId]);
    },
    failTurn: async (turnId, error) => {
      events.push(["fail", turnId, error]);
    },
  };
  const { client } = fakeClient(message("done"));
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
    [],
    recorder,
  );

  assert.equal(await agent.runTurn("hello", () => undefined), "done");
  assert.deepEqual(events, [
    ["start", "hello"],
    ["message", "turn-1", { role: "user", content: "hello" }],
    ["message", "turn-1", { role: "assistant", content: "done" }],
    ["complete", "turn-1"],
  ]);
});

test("ReActAgent 在模型失败时将 Turn 标记为 failed", async () => {
  const modelError = new Error("model unavailable");
  const events: unknown[] = [];
  const recorder: SessionRecorder = {
    startTurn: async () => {
      events.push(["start", "turn-1"]);
      return "turn-1";
    },
    appendMessage: async (turnId, value) => {
      events.push(["message", turnId, value]);
    },
    completeTurn: async (turnId) => {
      events.push(["complete", turnId]);
    },
    failTurn: async (turnId, error) => {
      events.push(["fail", turnId, error]);
    },
  };
  const client = {
    chat: {
      completions: {
        create: async () => {
          throw modelError;
        },
      },
    },
  };
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
    [],
    recorder,
  );

  await assert.rejects(
    () => agent.runTurn("hello", () => undefined),
    (error: unknown) => error === modelError,
  );
  assert.deepEqual(events, [
    ["start", "turn-1"],
    ["message", "turn-1", { role: "user", content: "hello" }],
    ["fail", "turn-1", modelError],
  ]);
});

test("ReActAgent 将恢复的历史消息放在当前 system message 之后", () => {
  const history = [
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
  ];
  const { client } = fakeClient();
  const agent = new ReActAgent(
    client,
    "model-x",
    "current prompt",
    new ToolRegistry([], {}),
    3,
    history,
  );

  history.push({ role: "user", content: "later mutation" });

  assert.deepEqual(agent.messages, [
    { role: "system", content: "current prompt" },
    { role: "user", content: "previous question" },
    { role: "assistant", content: "previous answer" },
  ]);
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

test("ReActAgent 将工具执行结果记录为 tool message", async () => {
  const persistedMessages: AgentMessage[] = [];
  const recorder: SessionRecorder = {
    startTurn: async () => "turn-1",
    appendMessage: async (_turnId, value) => {
      persistedMessages.push(value);
    },
    completeTurn: async () => undefined,
    failTurn: async () => undefined,
  };
  const { client } = fakeClient(
    message(null, [toolCall()]),
    message("finished"),
  );
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry(echoSpecs, {
      echo: ({ text }) => ({ ok: true, data: { text }, error: null }),
    }),
    3,
    [],
    recorder,
  );

  await agent.runTurn("run tool", () => undefined);

  assert.deepEqual(persistedMessages.map(({ role }) => role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.deepEqual(persistedMessages[2], {
    role: "tool",
    tool_call_id: "call-1",
    content: '{"ok":true,"data":{"text":"hello"},"error":null}',
  });
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

test("ReActAgent 累计本次会话的模型 Token 用量", async () => {
  const responses = [
    { choices: [{ message: message(null, [toolCall()]) }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    { choices: [{ message: message("finished") }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } },
  ];
  const client = {
    chat: { completions: { create: async () => responses.shift()! } },
  };
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry(echoSpecs, { echo: () => "ok" }),
    3,
  );

  await agent.runTurn("run", () => undefined);
  assert.deepEqual(agent.tokenUsage, {
    inputTokens: 30,
    outputTokens: 10,
    totalTokens: 40,
  });
});

test("ReActAgent 在供应商未返回 usage 时按零累计", async () => {
  const { client } = fakeClient(message("finished"));
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    1,
  );

  await agent.runTurn("run", () => undefined);
  assert.deepEqual(agent.tokenUsage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});
