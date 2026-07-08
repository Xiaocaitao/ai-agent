import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("CLI 在工作目录无效时以配置错误退出", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-cli-test-"));
  const missing = path.join(root, "missing");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  await assert.rejects(
    () => run(process.execPath, [entry, missing]),
    (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /配置错误: 工作目录不存在或不是目录/);
      return true;
    },
  );
});
