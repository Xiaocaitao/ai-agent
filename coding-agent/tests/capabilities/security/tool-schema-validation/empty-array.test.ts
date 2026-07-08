import assert from "node:assert/strict";
import test from "node:test";

import { createTestAgent, message, toolCall, toolObservation } from "./test-support.ts";

test("Schema 空命令参数数组时返回具体原因", async () => {
  const { agent } = await createTestAgent(
    message(null, [toolCall("run_command", { args: [] })]),
    message("recovered"),
  );

  assert.equal(await agent.runTurn("run empty command", () => undefined), "recovered");
  const observation = toolObservation(agent);
  assert.equal(observation.error, "工具参数校验失败");
  assert.deepEqual(observation.details, [{
    path: "/args",
    keyword: "minItems",
    message: "must NOT have fewer than 1 items",
    params: { limit: 1 },
  }]);
});
