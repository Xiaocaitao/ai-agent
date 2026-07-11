import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadTools, ToolRegistry } from "../../tools/registry.ts";
import { PermissionEngine } from "../../tools/permissions.ts";

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

test("loadTools 拒绝缺少或非法的工具权限", async () => {
  for (const permission of [undefined, "sometimes"]) {
    const root = await temporaryDirectory();
    await mkdir(path.join(root, "config"));
    await mkdir(path.join(root, "tools"));
    await writeFile(path.join(root, "tools/echo.ts"), "export const echo = () => 'ok';\n");
    await writeFile(path.join(root, "config/tools.json"), JSON.stringify({
      permissions: permission === undefined ? {} : { echo: permission },
      tools: [{
        name: "echo",
        module: "tools.echo",
        function: "echo",
        parameters: { type: "object" },
      }],
    }));

    await assert.rejects(() => loadTools(root), /工具 echo 权限配置缺失或非法/);
  }
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

test("ToolRegistry 在权限拒绝时不执行 Handler", async () => {
  let executed = false;
  const registry = new ToolRegistry(
    [{
      type: "function",
      function: { name: "write", parameters: { type: "object" } },
    }],
    { write: () => { executed = true; } },
    new PermissionEngine({ write: "deny" }),
  );

  const observation = JSON.parse(await registry.execute("write", "{}"));
  assert.equal(executed, false);
  assert.equal(observation.error, "工具执行被权限策略拒绝");
  assert.equal(observation.permission.action, "deny");
  assert.equal(observation.permission.retryable, false);
  assert.equal(observation.permission.must_not_bypass, true);
  assert.equal(observation.permission.retry_scope, "never");
});

test("用户拒绝审批只阻止当前轮，后续请求可以重新审批", async () => {
  const registry = new ToolRegistry(
    [{ type: "function", function: { name: "write", parameters: { type: "object" } } }],
    { write: () => "ok" },
    new PermissionEngine({ write: "ask" }, async () => "reject"),
  );

  const observation = JSON.parse(await registry.execute("write", "{}"));
  assert.equal(observation.permission.action, "ask");
  assert.equal(observation.permission.retryable, false);
  assert.equal(observation.permission.retry_scope, "current_turn");
  assert.equal(observation.permission.must_not_bypass, true);
});
