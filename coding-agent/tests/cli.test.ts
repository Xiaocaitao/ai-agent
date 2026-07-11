import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createApprovalPrompt } from "../cli.ts";

const run = promisify(execFile);

test("CLI 在工作目录无效时以配置错误退出", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-cli-test-"));
  const missing = path.join(root, "missing");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  await assert.rejects(
    () => run(process.execPath, ["--experimental-strip-types", entry, missing]),
    (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /配置错误: 工作目录不存在或不是目录/);
      return true;
    },
  );
});

test("CLI 审批输入映射为 once、session 和 reject", async () => {
  const answers = ["x", "y", "s", "n"];
  const lines: string[] = [];
  const prompt = createApprovalPrompt(
    { question: async () => answers.shift() ?? "n" },
    lines.push.bind(lines),
  );
  const request = { toolName: "write_file", arguments: {}, summary: "写入 a.ts" };

  assert.equal(await prompt(request), "once");
  assert.equal(await prompt(request), "session");
  assert.equal(await prompt(request), "reject");
  assert.ok(lines.some((line) => line.includes("请输入 y、s 或 n")));
});
