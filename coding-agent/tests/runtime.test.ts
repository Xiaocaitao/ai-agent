import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ReActAgent } from "../runtime/agent.ts";
import { sanitizeUnicode } from "../runtime/responses.ts";
import type { AgentItem } from "../runtime/responses.ts";
import type { SessionRecorder } from "../runtime/session.ts";
import { configureWorkspace, edit_file } from "../tools/index.ts";
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
  name: "echo",
  parameters: { type: "object" },
  strict: false,
}];

function fakeClient(...messages: ReturnType<typeof message>[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      responses: {
        create: async (request: unknown) => {
          calls.push(request);
          return modelResponse(messages.shift()!);
        },
      },
    },
  };
}

function modelResponse(
  value: ReturnType<typeof message>,
  usage?: { input_tokens: number; output_tokens: number; total_tokens: number },
) {
  const output = [
    ...(value.tool_calls ?? []).map((call) => ({
      type: "function_call" as const,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
    ...(value.content === null
      ? []
      : [{
          id: "message-1",
          type: "message" as const,
          role: "assistant" as const,
          status: "completed" as const,
          content: [{
            type: "output_text" as const,
            text: value.content,
            annotations: [],
            logprobs: [],
          }],
        }]),
  ];
  return {
    output,
    output_text: value.content ?? "",
    status: "completed" as const,
    usage,
  };
}

function inputMessage(
  role: "system" | "user" | "assistant",
  content: string,
) {
  return { type: "message" as const, role, content };
}

function assistantItem(content: string) {
  return modelResponse(message(content)).output[0]!;
}

function itemText(item: AgentItem | undefined): string | undefined {
  if (item?.type === "function_call_output") return item.output;
  if (item?.type !== "message") return undefined;
  if (typeof item.content === "string") return item.content;
  return item.content
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-runtime-test-"));
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
  assert.equal(itemText(agent.items.at(-1)), "done");
});

test("ReActAgent 按顺序记录无工具的成功 Turn", async () => {
  const events: unknown[] = [];
  const recorder: SessionRecorder = {
    startTurn: async (userInput) => {
      events.push(["start", userInput]);
      return "turn-1";
    },
    appendItem: async (turnId, value) => {
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
    ["message", "turn-1", inputMessage("user", "hello")],
    ["message", "turn-1", assistantItem("done")],
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
    appendItem: async (turnId, value) => {
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
    responses: {
      create: async () => {
        throw modelError;
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
    ["message", "turn-1", inputMessage("user", "hello")],
    ["fail", "turn-1", modelError],
  ]);
});

test("ReActAgent 复制恢复的原生历史 items", () => {
  const history = [
    inputMessage("user", "previous question"),
    inputMessage("assistant", "previous answer"),
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

  history.push(inputMessage("user", "later mutation"));

  assert.deepEqual(agent.items, [
    inputMessage("user", "previous question"),
    inputMessage("assistant", "previous answer"),
  ]);
});

test("ReActAgent 使用当前模型生成上下文摘要", async () => {
  const calls: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        calls.push(request);
        return modelResponse(message("  新摘要  "), {
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
        });
      },
    },
  };
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
  );

  assert.equal(
    await agent.createCompactionSummary("旧摘要", [
      inputMessage("user", "previous question"),
      inputMessage("assistant", "previous answer"),
    ]),
    "新摘要",
  );
  assert.deepEqual(agent.tokenUsage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  });

  const request = calls[0] as Record<string, unknown>;
  assert.equal(request.model, "model-x");
  assert.equal(request.max_output_tokens, 4_000);
  assert.match(String(request.instructions), /用户目标/);
  assert.deepEqual(request.input, [
    inputMessage("system", "会话历史摘要：\n旧摘要"),
    inputMessage("user", "previous question"),
    inputMessage("assistant", "previous answer"),
    inputMessage("user", "请输出更新后的会话摘要。"),
  ]);
});

test("ReActAgent 拒绝模型返回的空摘要", async () => {
  const { client } = fakeClient(message("   "));
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
  );

  await assert.rejects(
    () => agent.createCompactionSummary(undefined, [
      inputMessage("user", "previous question"),
    ]),
    /模型返回的摘要为空/,
  );
});

test("ReActAgent 应用压缩结果后替换历史并清除待压缩标记", async () => {
  const client = { responses: { create: async () =>
    modelResponse(message("current answer"), {
      input_tokens: 800_000,
      output_tokens: 1,
      total_tokens: 800_001,
    }) } };
  const agent = new ReActAgent(
    client,
    "model-x",
    "current prompt",
    new ToolRegistry([], {}),
    1,
    [
      inputMessage("user", "old question"),
      inputMessage("assistant", "old answer"),
    ],
    undefined,
    1_000_000,
  );
  await agent.runTurn("current question", () => undefined);
  assert.equal(agent.compactionPending, true);

  agent.applyCompaction([
    inputMessage("system", "会话历史摘要：\n新摘要"),
    inputMessage("user", "current question"),
    assistantItem("current answer"),
  ]);

  assert.deepEqual(agent.items, [
    inputMessage("system", "会话历史摘要：\n新摘要"),
    inputMessage("user", "current question"),
    assistantItem("current answer"),
  ]);
  assert.equal(agent.compactionPending, false);
});

test("ReActAgent 在下一 ReAct Step 前压缩旧 Turn 并保留当前 Turn", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const responses = [
    modelResponse(message(null, [toolCall()]), {
      input_tokens: 800_000,
      output_tokens: 1,
      total_tokens: 800_001,
    }),
    modelResponse(message("新摘要")),
    modelResponse(message("finished")),
  ];
  const client = {
    responses: {
      create: async (request: Record<string, unknown>) => {
        requests.push(request);
        return responses.shift()!;
      },
    },
  };
  const recorder: SessionRecorder = {
    startTurn: async () => "turn-current",
    appendItem: async () => undefined,
    completeTurn: async () => undefined,
    failTurn: async () => undefined,
    prepareCompaction: async () => ({
      previousSummary: undefined,
      throughTurnSequence: 1,
      items: [
        inputMessage("user", "old question-1"),
        inputMessage("assistant", "old answer-1"),
      ],
      recentItems: [
        inputMessage("user", "old question-2"),
        inputMessage("assistant", "old answer-2"),
      ],
    }),
    saveCompaction: async () => undefined,
  };
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry(echoSpecs, { echo: () => "tool result" }),
    3,
    [
      inputMessage("user", "old question-1"),
      inputMessage("assistant", "old answer-1"),
      inputMessage("user", "old question-2"),
      inputMessage("assistant", "old answer-2"),
    ],
    recorder,
    1_000_000,
  );

  assert.equal(await agent.runTurn("current question", () => undefined), "finished");

  const secondStepItems = requests[2]?.input as AgentItem[];
  assert.deepEqual(secondStepItems.map((item) => item.type), [
    "message",
    "message",
    "message",
    "message",
    "function_call",
    "function_call_output",
  ]);
  assert.deepEqual(secondStepItems.slice(0, 4), [
    inputMessage("system", "会话历史摘要：\n新摘要"),
    inputMessage("user", "old question-2"),
    inputMessage("assistant", "old answer-2"),
    inputMessage("user", "current question"),
  ]);
  assert.equal(
    secondStepItems.some((item) => itemText(item) === "old question-1"),
    false,
  );
});

test("ReActAgent 在最终回答完成后由 Runtime 执行压缩", async () => {
  const responses = [
    modelResponse(message("current answer"), {
      input_tokens: 800_000,
      output_tokens: 1,
      total_tokens: 800_001,
    }),
    modelResponse(message("新摘要")),
  ];
  let saved: unknown;
  const recorder: SessionRecorder = {
    startTurn: async () => "turn-current",
    appendItem: async () => undefined,
    completeTurn: async () => undefined,
    failTurn: async () => undefined,
    prepareCompaction: async () => ({
      previousSummary: "旧摘要",
      throughTurnSequence: 3,
      items: [
        inputMessage("user", "old question"),
        inputMessage("assistant", "old answer"),
      ],
      recentItems: [
        inputMessage("user", "current question"),
        assistantItem("current answer"),
      ],
    }),
    saveCompaction: async (summary, throughTurnSequence) => {
      saved = { summary, throughTurnSequence };
    },
  };
  const client = {
    responses: { create: async () => responses.shift()! },
  };
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    1,
    [
      inputMessage("user", "old question"),
      inputMessage("assistant", "old answer"),
    ],
    recorder,
    1_000_000,
  );

  assert.equal(await agent.runTurn("current question", () => undefined), "current answer");
  assert.deepEqual(saved, { summary: "新摘要", throughTurnSequence: 3 });
  assert.deepEqual(agent.items, [
    inputMessage("system", "会话历史摘要：\n新摘要"),
    inputMessage("user", "current question"),
    assistantItem("current answer"),
  ]);
  assert.equal(agent.compactionPending, false);
});

test("ReActAgent 压缩失败时保留原上下文并继续返回最终回答", async () => {
  const responses = [
    modelResponse(message("current answer"), {
      input_tokens: 800_000,
      output_tokens: 1,
      total_tokens: 800_001,
    }),
  ];
  const client = {
    responses: {
      create: async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("summary unavailable");
        return response;
      },
    },
  };
  const recorder: SessionRecorder = {
    startTurn: async () => "turn-current",
    appendItem: async () => undefined,
    completeTurn: async () => undefined,
    failTurn: async () => undefined,
    prepareCompaction: async () => ({
      previousSummary: undefined,
      throughTurnSequence: 1,
      items: [inputMessage("user", "old question")],
      recentItems: [inputMessage("user", "current question")],
    }),
    saveCompaction: async () => {
      throw new Error("不应保存失败摘要");
    },
  };
  const output: string[] = [];
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    1,
    [inputMessage("user", "old question")],
    recorder,
    1_000_000,
  );

  assert.equal(
    await agent.runTurn("current question", output.push.bind(output)),
    "current answer",
  );
  assert.equal(agent.compactionPending, true);
  assert.ok(
    output.includes("[Context] Compact 警告：summary unavailable"),
  );
  assert.equal(
    agent.items.some((item) => itemText(item) === "old question"),
    true,
  );
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
  assert.deepEqual(agent.items.map((item) => item.type), [
    "message",
    "function_call",
    "function_call_output",
    "message",
  ]);
  assert.deepEqual(JSON.parse(String(itemText(agent.items[2]))), {
    ok: true,
    data: { text: "hello" },
    error: null,
  });
  assert.ok(output.some((line) => line.includes("Action:")));
  assert.ok(output.some((line) => line.includes("Observation:")));
});

test("ReActAgent 汇总同一 Turn 的文件修改", async () => {
  const root = await temporaryDirectory();
  await writeFile(path.join(root, "example.ts"), "const enabled = false;\n");
  configureWorkspace(root);
  const editFileSpec = [{
    type: "function" as const,
    name: "edit_file",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
    strict: false,
  }];
  const { client } = fakeClient(
    message(null, [toolCall("edit_file", JSON.stringify({
      path: "example.ts",
      old_text: "const enabled = false;",
      new_text: "const enabled = 'middle';",
    }), "call-1")]),
    message(null, [toolCall("edit_file", JSON.stringify({
      path: "example.ts",
      old_text: "const enabled = 'middle';",
      new_text: "const enabled = true;",
    }), "call-2")]),
    message("finished"),
  );
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry(editFileSpec, { edit_file }),
    3,
  );

  await agent.runTurn("edit file", () => undefined);

  assert.equal(agent.lastTurnFileChanges.length, 1);
  assert.equal(agent.lastTurnFileChanges[0]?.path, "example.ts");
  assert.match(agent.lastTurnFileChanges[0]?.diff ?? "", /-const enabled = false;/);
  assert.match(agent.lastTurnFileChanges[0]?.diff ?? "", /\+const enabled = true;/);
  assert.doesNotMatch(agent.lastTurnFileChanges[0]?.diff ?? "", /middle/);
});

test("ReActAgent 将工具执行结果记录为 function_call_output item", async () => {
  const persistedItems: AgentItem[] = [];
  const recorder: SessionRecorder = {
    startTurn: async () => "turn-1",
    appendItem: async (_turnId, value) => {
      persistedItems.push(value);
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

  assert.deepEqual(persistedItems.map((item) => item.type), [
    "message",
    "function_call",
    "function_call_output",
    "message",
  ]);
  assert.deepEqual(persistedItems[2], {
    type: "function_call_output",
    call_id: "call-1",
    output: '{"ok":true,"data":{"text":"hello"},"error":null}',
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
    const observation = agent.items.find((value) =>
      value.type === "function_call_output"
    );
    assert.match(String(itemText(observation)), new RegExp(item.expected));
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
    modelResponse(message(null, [toolCall()]), {
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
    }),
    modelResponse(message("finished"), {
      input_tokens: 20,
      output_tokens: 6,
      total_tokens: 26,
    }),
  ];
  const client = {
    responses: { create: async () => responses.shift()! },
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

test("ReActAgent 只在上下文达到 80% 时警告并标记待压缩", async () => {
  for (const item of [
    { promptTokens: 799_999, shouldWarn: false },
    { promptTokens: 800_000, shouldWarn: true },
  ]) {
    const output: string[] = [];
    const client = {
      responses: {
        create: async () => modelResponse(message("finished"), {
          input_tokens: item.promptTokens,
          output_tokens: 1,
          total_tokens: item.promptTokens + 1,
        }),
      },
    };
    const agent = new ReActAgent(
      client,
      "model-x",
      "prompt",
      new ToolRegistry([], {}),
      1,
      [],
      undefined,
      1_000_000,
    );

    await agent.runTurn("run", output.push.bind(output));

    assert.equal(
      output.some((line) => line.startsWith("[Context]")),
      item.shouldWarn,
    );
    assert.equal(agent.compactionPending, item.shouldWarn);
    if (item.shouldWarn) {
      assert.ok(
        output.includes(
          "[Context] 警告：上下文已使用 800000/1000000 Tokens（80.0%）",
        ),
      );
    }
  }
});

test("ReActAgent 在供应商未返回 usage 时按零累计", async () => {
  const { client } = fakeClient(message("finished"));
  const output: string[] = [];
  const agent = new ReActAgent(
    client,
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    1,
    [],
    undefined,
    1_000_000,
  );

  await agent.runTurn("run", output.push.bind(output));
  assert.deepEqual(agent.tokenUsage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  assert.equal(
    output.some((line) => line.startsWith("[Context]")),
    false,
  );
});
