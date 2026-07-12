import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  createApprovalPrompt,
  formatTokenUsage,
  prepareCliWorkspace,
} from "../cli.ts";

const run = promisify(execFile);

test("CLI 工作区有效时必须执行沙箱预检", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-cli-test-"));
  let checked = false;

  assert.equal(
    prepareCliWorkspace(root, () => {
      checked = true;
    }),
    realpathSync(root),
  );
  assert.equal(checked, true);
});

test("CLI 工作区无效时不继续执行沙箱预检", () => {
  let checked = false;
  assert.throws(
    () =>
      prepareCliWorkspace("/missing/coding-agent-workspace", () => {
        checked = true;
      }),
    /工作目录不存在或不是目录/,
  );
  assert.equal(checked, false);
});

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
  const request = {
    toolName: "write_file",
    arguments: {},
    summary: "写入 a.ts",
    canRemember: true,
  };

  assert.equal(await prompt(request), "once");
  assert.equal(await prompt(request), "session");
  assert.equal(await prompt(request), "reject");
  assert.ok(lines.some((line) => line.includes("请输入 y、s 或 n")));
});

test("CLI 对不能会话授权的请求不展示 session 选项", async () => {
  const lines: string[] = [];
  const prompt = createApprovalPrompt(
    { question: async () => "y" },
    lines.push.bind(lines),
  );

  assert.equal(
    await prompt({
      toolName: "run_command",
      arguments: {},
      summary: "执行 bash -c echo ok",
      canRemember: false,
    }),
    "once",
  );
  assert.ok(lines.some((line) => line.includes("[y] 仅本次允许  [n] 拒绝")));
  assert.equal(lines.some((line) => line.includes("[s]")), false);
});

test("CLI 格式化退出时的 Token 汇总", () => {
  assert.equal(
    formatTokenUsage({ inputTokens: 1234, outputTokens: 567, totalTokens: 1801 }),
    "本次会话 Token 用量：\n输入：1234\n输出：567\n总计：1801",
  );
});
