import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTestAgent, message, toolCall, toolObservation } from "./test-support.ts";

test("Schema 属性类型错误时不执行工具", async () => {
  const { agent, root } = await createTestAgent(
    message(null, [toolCall("write_file", {
      path: ["schema-bypass.txt"],
      content: "should not be written",
    }, "invalid-property-type")]),
    message("recovered"),
  );

  assert.equal(await agent.runTurn("write invalid arguments", () => undefined), "recovered");
  assert.equal(existsSync(path.join(root, "schema-bypass.txt")), false, "类型错误的参数不应触发文件写入");
  const observation = toolObservation(agent);
  assert.equal(observation.error, "工具参数校验失败");
  assert.deepEqual(observation.details, [{
    path: "/path",
    keyword: "type",
    message: "must be string",
    params: { type: "string" },
  }]);
});
