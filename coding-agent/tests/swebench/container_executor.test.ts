import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configureWorkspace } from "../../tools/_common.ts";
import {
  configureCommandExecutor,
  resetCommandExecutor,
  runCommand,
} from "../../tools/run_command.ts";
import { createContainerCommandExecutor } from "../../eval/swebench/container_executor.ts";

test("Docker Worker 使用容器内直接进程执行器，不触发 macOS Seatbelt", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "coding-agent-worker-"));
  configureWorkspace(workspace);
  configureCommandExecutor(createContainerCommandExecutor());
  try {
    const result = await runCommand(["printf", "worker-ok"]);
    assert.equal(result.ok, true);
    assert.equal(result.data.stdout, "worker-ok");
    assert.equal(result.data.sandboxed, true);
  } finally {
    resetCommandExecutor();
  }
});
