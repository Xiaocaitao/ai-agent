import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTools, ReActAgent } from "../../../../agent.ts";
import { configureWorkspace } from "../../../../tools/index.ts";

test("Schema 属性类型错误时不执行工具", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-schema-test-"));
  configureWorkspace(root);
  const { specs, handlers } = await loadTools();
  // 构造错误的llm工具调用回复
  const responses = [
    {
      content: null,
      tool_calls: [
        {
          id: "invalid-property-type",
          type: "function" as const,
          function: {
            name: "write_file",
            arguments: JSON.stringify({
              path: ["schema-bypass.txt"], // 非法参数
              content: "should not be written",
            }),
          },
        },
      ],
    },
    { content: "recovered" },
  ];
  const client = {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: responses.shift()! }] }),
      },
    },
  };
  const agent = new ReActAgent(client, "model-x", "prompt", specs, handlers, 3);

  assert.equal(
    await agent.runTurn("write invalid arguments", () => undefined),
    "recovered",
  );
  assert.equal(
    existsSync(path.join(root, "schema-bypass.txt")),
    false,
    "类型错误的参数不应触发文件写入",
  );
  assert.match(String(agent.messages[3]?.content), /工具参数校验失败/);
});
