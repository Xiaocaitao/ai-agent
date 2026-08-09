import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createTestAgent, message, toolCall } from "./test-support.ts";

test("模型收到校验原因后可以修正参数并重试", async () => {
  const { agent, calls, root } = await createTestAgent(
    message(null, [toolCall("write_file", {
      path: ["retried.txt"],
      content: "corrected",
    }, "invalid-call")]),
    message(null, [toolCall("write_file", {
      path: "retried.txt",
      content: "corrected",
    }, "corrected-call")]),
    message("done"),
  );

  assert.equal(await agent.runTurn("retry invalid arguments", () => undefined), "done");
  const secondRequest = calls[1] as {
    input: Array<{ type: string; output?: string }>;
  };
  const feedback = secondRequest.input.at(-1);
  assert.equal(feedback?.type, "function_call_output");
  assert.equal(JSON.parse(String(feedback?.output)).error, "工具参数校验失败");
  assert.equal(await readFile(path.join(root, "retried.txt"), "utf8"), "corrected");
});
