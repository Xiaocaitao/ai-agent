import assert from "node:assert/strict";
import test from "node:test";

import { createTestAgent, message, toolCall, toolObservation } from "./test-support.ts";

test("Schema 空查询字符串时返回具体原因", async () => {
  const { agent } = await createTestAgent(
    message(null, [toolCall("search_files", { query: "" })]),
    message("recovered"),
  );

  assert.equal(await agent.runTurn("search empty query", () => undefined), "recovered");
  const observation = toolObservation(agent);
  assert.equal(observation.error, "工具参数校验失败");
  assert.deepEqual(observation.details, [{
    path: "/query",
    keyword: "minLength",
    message: "must NOT have fewer than 1 characters",
    params: { limit: 1 },
  }]);
});
