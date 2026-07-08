import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createTestAgent, message, toolCall, toolObservation } from "./test-support.ts";

test("Schema 出现额外属性时不执行工具", async () => {
  const { agent, root } = await createTestAgent(
    message(null, [toolCall("write_file", {
      path: "additional-property.txt",
      content: "should not be written",
      unexpected: true,
    })]),
    message("recovered"),
  );

  assert.equal(await agent.runTurn("write with additional property", () => undefined), "recovered");
  assert.equal(existsSync(path.join(root, "additional-property.txt")), false, "额外属性不应触发文件写入");
  const observation = toolObservation(agent);
  assert.equal(observation.error, "工具参数校验失败");
  assert.deepEqual(observation.details, [{
    path: "$",
    keyword: "additionalProperties",
    message: "must NOT have additional properties",
    params: { additionalProperty: "unexpected" },
  }]);
});
