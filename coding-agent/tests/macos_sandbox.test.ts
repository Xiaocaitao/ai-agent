import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  MACOS_SANDBOX_EXECUTABLE,
  MACOS_SANDBOX_PROFILE,
  assertMacOsSandboxAvailable,
  buildSandboxedCommand,
  sanitizeChildEnvironment,
} from "../tools/macos_sandbox.ts";

test("macOS 沙箱依赖存在", () => {
  assert.doesNotThrow(() => assertMacOsSandboxAvailable());
  assert.equal(MACOS_SANDBOX_EXECUTABLE, "/usr/bin/sandbox-exec");
  assert.equal(path.basename(MACOS_SANDBOX_PROFILE), "macos-workspace.sb");
});

test("沙箱命令保持原始 argv，不引入外层 Shell", () => {
  const cwd = path.resolve(import.meta.dirname, "..");
  const original = ["/bin/echo", "a b", ";", "$(touch bad)", "line1\nline2"];
  const command = buildSandboxedCommand(original, cwd, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/demo",
    AGENT_API_KEY: "secret",
  });

  assert.equal(command.executable, "/usr/bin/sandbox-exec");
  assert.deepEqual(command.args.slice(-original.length), original);
  assert.equal(command.env.AGENT_API_KEY, undefined);
  assert.equal(command.env.PATH, "/usr/bin:/bin");
  assert.equal(command.env.TMPDIR, "/private/tmp");
});

test("子进程环境只保留必要变量", () => {
  const env = sanitizeChildEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/demo",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    AGENT_API_KEY: "a",
    OPENAI_API_KEY: "b",
    GITHUB_TOKEN: "c",
    DATABASE_PASSWORD: "d",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    HTTP_PROXY: "http://user:pass@example.com",
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/demo",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/private/tmp",
  });
});
