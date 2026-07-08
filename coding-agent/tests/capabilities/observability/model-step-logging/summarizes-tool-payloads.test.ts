import assert from "node:assert/strict";
import test from "node:test";

import { ReActAgent } from "../../../../agent.ts";
import type { ToolHandler } from "../../../../agent.ts";
import { choice, echoSpecs, fakeClient, message } from "./test-support.ts";

test("日志省略工具正文但消息历史保留完整内容", async () => {
  const secret = "VERY_SECRET_SOURCE";
  const call = {
    id: "call-content",
    type: "function" as const,
    function: {
      name: "echo",
      arguments: JSON.stringify({ path: "demo.txt", content: secret }),
    },
  };
  const handlers: Record<string, ToolHandler> = {
    echo: ({ path, content }) => ({ ok: true, data: { path, content }, error: null }),
  };
  const agent = new ReActAgent(
    fakeClient(
      choice({ content: null, tool_calls: [call] }, "tool_calls"),
      choice(message("done"), "stop"),
    ),
    "model-x",
    "prompt",
    echoSpecs,
    handlers,
    3,
  );
  const logs: string[] = [];

  assert.equal(await agent.runTurn("read content", logs.push.bind(logs)), "done");
  assert.ok(logs.every((line) => !line.includes(secret)));
  assert.ok(logs.some((line) => line.includes("<省略 18 字符>")));
  assert.match(String(agent.messages[3]?.content), new RegExp(secret));
});
