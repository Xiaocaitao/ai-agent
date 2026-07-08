import assert from "node:assert/strict";
import test from "node:test";

import { ReActAgent } from "../../../../runtime.ts";
import { ToolRegistry } from "../../../../tools/registry.ts";
import { choice, fakeClient, message } from "./test-support.ts";

test("日志明确标记模型空响应", async () => {
  const agent = new ReActAgent(
    fakeClient(choice(message(null), "stop")),
    "model-x",
    "prompt",
    new ToolRegistry([], {}),
    3,
  );
  const logs: string[] = [];

  assert.equal(await agent.runTurn("empty", logs.push.bind(logs)), "");
  assert.deepEqual(logs, [
    "[Step 1/3] → 请求模型",
    "[Step 1/3] ← 空响应，finish_reason=stop",
  ]);
});
