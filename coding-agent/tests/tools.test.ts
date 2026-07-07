import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureWorkspace,
  readFileTool,
  runCommand,
  searchFiles,
  writeFileTool,
} from "../tools/index.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-test-"));
}

test("runCommand 传递 stdin 并返回 stdout", async () => {
  const result = await runCommand(
    [process.execPath, "-e", "process.stdin.on('data', data => process.stdout.write(data.toString().toUpperCase()))"],
    "hello",
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.stdout, "HELLO");
  assert.equal(result.data.exit_code, 0);
});

test("runCommand 报告非零退出码和 stderr", async () => {
  const result = await runCommand([process.execPath, "-e", "console.error('bad'); process.exit(2)"]);
  assert.equal(result.ok, false);
  assert.equal(result.data.exit_code, 2);
  assert.equal(result.data.stderr, "bad\n");
});

test("runCommand 支持超时和输出截断", async () => {
  const timeout = await runCommand([process.execPath, "-e", "setTimeout(() => {}, 2000)"], null, ".", 1);
  assert.equal(timeout.ok, false);
  assert.equal(timeout.data.timed_out, true);

  const truncated = await runCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(21000))"]);
  assert.equal(String(truncated.data.stdout).length, 20_000);
  assert.equal(truncated.data.truncated, true);
});

test("runCommand 不解释 shell 操作符并拦截删除命令", async () => {
  const literal = await runCommand([process.execPath, "-e", "console.log(process.argv.slice(1))", "&&", "echo", "bad"]);
  assert.match(String(literal.data.stdout), /&&/);
  assert.doesNotMatch(String(literal.data.stdout), /\nbad\n/);
  assert.equal((await runCommand(["rm", "file.txt"])).ok, false);
  assert.equal((await runCommand([process.execPath, "--version"], null, "../")).ok, false);
});

test("文件工具创建、覆盖并按行读取", async () => {
  const root = await temporaryDirectory();
  configureWorkspace(root);
  assert.equal((await writeFileTool("nested/data.txt", "one\ntwo\nthree\n")).ok, true);
  assert.equal((await writeFileTool("nested/data.txt", "alpha\nbeta\ngamma\n")).ok, true);
  const result = await readFileTool("nested/data.txt", 2, 1);
  assert.equal(result.ok, true);
  assert.equal(result.data.content, "beta\n");
  assert.equal(result.data.end_line, 2);
  assert.equal(result.data.truncated, true);
  assert.equal(await readFile(path.join(root, "nested/data.txt"), "utf8"), "alpha\nbeta\ngamma\n");
});

test("文件工具拒绝越界、符号链接和非法行参数", async () => {
  const root = await temporaryDirectory();
  const outside = await temporaryDirectory();
  await symlink(outside, path.join(root, "link"), "dir");
  configureWorkspace(root);
  assert.equal((await readFileTool("../outside.txt")).ok, false);
  assert.equal((await writeFileTool("link/data.txt", "secret")).ok, false);
  assert.equal((await readFileTool("file.txt", 0)).ok, false);
  assert.equal((await readFileTool("file.txt", 1, 0)).ok, false);
});

test("searchFiles 按 glob 搜索并限制为 100 条", async () => {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, "src/main.ts"), "needle\n".repeat(101));
  await writeFile(path.join(root, "src/skip.txt"), "needle\n");
  await writeFile(path.join(root, ".git/hidden.ts"), "needle\n");
  await writeFile(path.join(root, "src/binary.ts"), Buffer.from("needle\0data"));
  configureWorkspace(root);
  const result = await searchFiles("needle", "src", "*.ts");
  assert.equal(result.ok, true);
  const matches = result.data.matches as Array<{ path: string }>;
  assert.equal(matches.length, 100);
  assert.equal(result.data.truncated, true);
  assert.ok(matches.every((match) => match.path === "src/main.ts"));
});
