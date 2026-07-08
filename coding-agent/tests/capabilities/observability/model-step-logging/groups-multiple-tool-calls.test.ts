import assert from "node:assert/strict";
import test from "node:test";

import { ReActAgent } from "../../../../agent.ts";
import { ToolRegistry } from "../../../../tools/registry.ts";
import { choice, echoHandlers, echoSpecs, fakeClient, message, toolCall } from "./test-support.ts";

test("日志标明同一次模型回复包含的多个工具", async () => {
  const client = fakeClient(
    choice(message(null, [toolCall("one", "call-1"), toolCall("two", "call-2")]), "tool_calls"),
    choice(message("done"), "stop"),
  );
  const agent = new ReActAgent(client, "model-x", "prompt", new ToolRegistry(echoSpecs, echoHandlers), 3);
  const logs: string[] = [];

  assert.equal(await agent.runTurn("run two tools", logs.push.bind(logs)), "done");
  assert.deepEqual(logs, [
    "[Step 1/3] → 请求模型",
    "[Step 1/3] ← 工具调用，共 2 个，finish_reason=tool_calls",
    "  [Tool 1/2] Action: echo({\"text\":\"one\"})",
    "  [Tool 1/2] Observation: {\"ok\":true,\"data\":{\"text\":\"one\"},\"error\":null}",
    "  [Tool 2/2] Action: echo({\"text\":\"two\"})",
    "  [Tool 2/2] Observation: {\"ok\":true,\"data\":{\"text\":\"two\"},\"error\":null}",
    "[Step 2/3] → 请求模型",
    "[Step 2/3] ← 最终回答，finish_reason=stop",
  ]);
});
