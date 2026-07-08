import assert from "node:assert/strict";
import test from "node:test";

import { createTestAgent, message, toolCall, toolObservation } from "./test-support.ts";

test("Schema 数值越界时返回具体原因", async () => {
  const { agent } = await createTestAgent(
    message(null, [toolCall("run_command", {
      args: [process.execPath, "--version"],
      timeout: 121,
    })]),
    message("recovered"),
  );

  assert.equal(await agent.runTurn("run with invalid timeout", () => undefined), "recovered");
  const observation = toolObservation(agent);
  assert.equal(observation.error, "工具参数校验失败");
  assert.deepEqual(observation.details, [{
    path: "/timeout",
    keyword: "maximum",
    message: "must be <= 120",
    params: { comparison: "<=", limit: 120 },
  }]);
});
