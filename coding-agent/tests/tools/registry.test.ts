import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTools, ToolRegistry } from "../../tools/registry.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-registry-test-"));
}

test("loadTools 加载项目工具并支持空注册表", async () => {
  const empty = await temporaryDirectory();
  await mkdir(path.join(empty, "config"));
  await writeFile(path.join(empty, "config/tools.json"), '{"tools": []}\n');
  assert.deepEqual((await loadTools(empty)).specs, []);

  const registry = await loadTools();
  assert.deepEqual(
    registry.specs.map((spec) => spec.function.name).sort(),
    ["read_file", "run_command", "search_files", "write_file"],
  );
});

test("ToolRegistry 统一执行工具并返回 Observation", async () => {
  const registry = new ToolRegistry(
    [{
      type: "function",
      function: {
        name: "echo",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    }],
    { echo: ({ text }) => ({ ok: true, data: { text }, error: null }) },
  );

  assert.equal(
    await registry.execute("echo", '{"text":"hello"}'),
    '{"ok":true,"data":{"text":"hello"},"error":null}',
  );
  assert.equal(await registry.execute("missing", "{}"), "未注册工具: missing");
  assert.equal(await registry.execute("echo", "{"), "参数不是合法 JSON: {");
});
