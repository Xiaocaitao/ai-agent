import assert from "node:assert/strict";
import test from "node:test";

import { createTestAgent, message, toolCall, toolObservation } from "./test-support.ts";

test("Schema 必填属性缺失时返回具体原因", async () => {
  const { agent } = await createTestAgent(
    message(null, [toolCall("write_file", { path: "missing-content.txt" })]),
    message("recovered"),
  );

  assert.equal(await agent.runTurn("write without content", () => undefined), "recovered");
  const observation = toolObservation(agent);
  assert.equal(observation.error, "工具参数校验失败");
  assert.deepEqual(observation.details, [{
    path: "$",
    keyword: "required",
    message: "must have required property 'content'",
    params: { missingProperty: "content" },
  }]);
});
