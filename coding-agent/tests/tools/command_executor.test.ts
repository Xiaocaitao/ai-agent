import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configureWorkspace } from "../../tools/_common.ts";
import {
  configureCommandExecutor,
  resetCommandExecutor,
  runCommand,
  type CommandData,
} from "../../tools/run_command.ts";

const macOsOnly = { skip: process.platform !== "darwin" };

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-command-executor-test-"));
}

function result(overrides: Partial<CommandData> = {}): CommandData {
  return {
    stdout: "container output\n",
    stderr: "",
    exit_code: 0,
    timed_out: false,
    truncated: false,
    sandboxed: true,
    ...overrides,
  };
}

test("runCommand 使用配置的命令执行后端并传递 workspace 相对目录", async () => {
  const root = await workspace();
  configureWorkspace(root);
  const calls: Array<{ args: string[]; stdin: string | null; cwd: string; timeout: number }> = [];
  configureCommandExecutor(async (args, stdin, timeout, cwd) => {
    calls.push({ args, stdin, timeout, cwd });
    return result();
  });

  try {
    const response = await runCommand(
      ["pytest", "-q"],
      "input",
      "src",
      12,
    );

    assert.equal(response.ok, true);
    assert.equal(response.data.stdout, "container output\n");
    const canonicalRoot = await realpath(root);
    assert.deepEqual(calls, [{
      args: ["pytest", "-q"],
      stdin: "input",
      timeout: 12,
      cwd: path.join(canonicalRoot, "src"),
    }]);
  } finally {
    resetCommandExecutor();
  }
});

test("配置的命令执行后端返回超时结果时保留 sandbox metadata", async () => {
  const root = await workspace();
  configureWorkspace(root);
  configureCommandExecutor(async () => result({
    exit_code: null,
    timed_out: true,
    sandbox_denied: true,
  }));

  try {
    const response = await runCommand(["pytest", "-q"]);

    assert.equal(response.ok, false);
    assert.equal(response.error, "命令执行超时: 30 秒");
    assert.equal(response.data.sandbox_denied, true);
  } finally {
    resetCommandExecutor();
  }
});

test("未配置执行后端时保留现有 macOS Seatbelt 路径", macOsOnly, async () => {
  resetCommandExecutor();
  const root = await workspace();
  configureWorkspace(root);

  const response = await runCommand(["printf", "ok"]);

  assert.equal(response.ok, true);
  assert.equal(response.data.sandboxed, true);
});
