import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import { editFileTool } from "../tools/edit_file.ts";
import { executePreparedCommand } from "../tools/run_command.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-test-"));
}

function directCommand(args: string[]) {
  return {
    executable: args[0],
    args: args.slice(1),
    env: process.env,
    sandboxed: false,
  };
}

test("runCommand 传递 stdin 并返回 stdout", async () => {
  const result = await executePreparedCommand(
    directCommand([process.execPath, "-e", "process.stdin.on('data', data => process.stdout.write(data.toString().toUpperCase()))"]),
    "hello",
    30,
    process.cwd(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.stdout, "HELLO");
  assert.equal(result.data.exit_code, 0);
});

test("runCommand 报告非零退出码和 stderr", async () => {
  const result = await executePreparedCommand(
    directCommand([process.execPath, "-e", "console.error('bad'); process.exit(2)"]),
    null,
    30,
    process.cwd(),
  );
  assert.equal(result.ok, false);
  assert.equal(result.data.exit_code, 2);
  assert.equal(result.data.stderr, "bad\n");
});

test("runCommand 支持超时和输出截断", async () => {
  const timeout = await executePreparedCommand(
    directCommand([process.execPath, "-e", "setTimeout(() => {}, 2000)"]),
    null,
    1,
    process.cwd(),
  );
  assert.equal(timeout.ok, false);
  assert.equal(timeout.data.timed_out, true);

  const truncated = await executePreparedCommand(
    directCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(21000))"]),
    null,
    30,
    process.cwd(),
  );
  assert.equal(String(truncated.data.stdout).length, 20_000);
  assert.equal(truncated.data.truncated, true);
});

test("runCommand 不解释 shell 操作符并拦截删除命令", async () => {
  const literal = await executePreparedCommand(
    directCommand([process.execPath, "-e", "console.log(process.argv.slice(1))", "&&", "echo", "bad"]),
    null,
    30,
    process.cwd(),
  );
  assert.match(String(literal.data.stdout), /&&/);
  assert.doesNotMatch(String(literal.data.stdout), /\nbad\n/);
  assert.equal((await runCommand(["rm", "file.txt"])).ok, false);
  assert.equal((await runCommand(["bash", "-c", "rm file.txt"])).ok, false);
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

test("editFileTool 只替换唯一匹配的文本", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "src/example.ts");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "const enabled = false;\nconst name = 'agent';\n");
  configureWorkspace(root);

  const result = await editFileTool(
    "src/example.ts",
    "const enabled = false;",
    "const enabled = true;",
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.path, "src/example.ts");
  assert.equal(result.data.replacements, 1);
  assert.equal(
    await readFile(target, "utf8"),
    "const enabled = true;\nconst name = 'agent';\n",
  );
});

test("editFileTool 找不到匹配文本时不修改文件", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "example.ts");
  const original = "const enabled = false;\n";
  await writeFile(target, original);
  configureWorkspace(root);

  const result = await editFileTool(
    "example.ts",
    "const enabled = true;",
    "const enabled = false;",
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.matches, 0);
  assert.equal(await readFile(target, "utf8"), original);
});

test("editFileTool 匹配多处时不修改文件", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "example.ts");
  const original = "return false;\nreturn false;\n";
  await writeFile(target, original);
  configureWorkspace(root);

  const result = await editFileTool(
    "example.ts",
    "return false;",
    "return true;",
  );

  assert.equal(result.ok, false);
  assert.equal(result.data.matches, 2);
  assert.equal(await readFile(target, "utf8"), original);
});

test("editFileTool 支持用空字符串删除唯一匹配文本", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "example.ts");
  await writeFile(target, "before\nremove me\nafter\n");
  configureWorkspace(root);

  const result = await editFileTool("example.ts", "remove me\n", "");

  assert.equal(result.ok, true);
  assert.equal(await readFile(target, "utf8"), "before\nafter\n");
});

test("editFileTool 拒绝不存在的文件和符号链接", async () => {
  const root = await temporaryDirectory();
  const original = path.join(root, "original.ts");
  await writeFile(original, "const value = 1;\n");
  await symlink(original, path.join(root, "link.ts"));
  configureWorkspace(root);

  assert.equal((await editFileTool(
    "missing.ts",
    "const value = 1;",
    "const value = 2;",
  )).ok, false);
  assert.equal((await editFileTool(
    "link.ts",
    "const value = 1;",
    "const value = 2;",
  )).ok, false);
  assert.equal(await readFile(original, "utf8"), "const value = 1;\n");
});

test("editFileTool 原子替换后保留原文件权限", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "script.sh");
  await writeFile(target, "echo before\n");
  await chmod(target, 0o764);
  configureWorkspace(root);

  const previousUmask = process.umask(0o077);
  try {
    const result = await editFileTool(
      "script.sh",
      "echo before",
      "echo after",
    );
    assert.equal(result.ok, true);
  } finally {
    process.umask(previousUmask);
  }

  assert.equal((await stat(target)).mode & 0o777, 0o764);
});

test("edit_file Handler 将工具参数传给 editFileTool", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "example.ts");
  await writeFile(target, "const enabled = false;\n");
  configureWorkspace(root);

  const tools = await import("../tools/index.ts");
  const editFile = (tools as Record<string, unknown>).edit_file;
  assert.equal(typeof editFile, "function");
  if (typeof editFile !== "function") return;

  const result = await editFile({
    path: "example.ts",
    old_text: "const enabled = false;",
    new_text: "const enabled = true;",
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(target, "utf8"), "const enabled = true;\n");
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
