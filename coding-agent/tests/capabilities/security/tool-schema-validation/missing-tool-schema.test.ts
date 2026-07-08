import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTools } from "../../../../tools/registry.ts";

test("工具缺少参数 Schema 时拒绝加载", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-missing-schema-test-"));
  await mkdir(path.join(root, "config"));
  await mkdir(path.join(root, "tools"));
  await writeFile(path.join(root, "config/tools.json"), JSON.stringify({
    tools: [{ name: "echo", module: "tools.echo", function: "echo" }],
  }));
  await writeFile(path.join(root, "tools/echo.ts"), "export function echo() { return 'ok'; }\n");

  await assert.rejects(() => loadTools(root), /工具 echo 缺少参数 Schema/);
});
