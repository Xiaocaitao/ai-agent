import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPiCommand,
  parsePiJsonEvents,
} from "../../eval/swebench/pi_runner.ts";

test("Pi 命令固定无交互审批、独立 session 和受限工具", () => {
  const command = buildPiCommand({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    command: "/opt/pi/pi-test.sh",
    sessionDirectory: "/results/pi-session",
    problemStatement: "Fix the regression.",
  });

  assert.deepEqual(command, [
    "/opt/pi/pi-test.sh",
    "--provider", "deepseek",
    "--model", "deepseek-v4-flash",
    "--print",
    "--mode", "json",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--tools", "read,bash,edit,write,grep,find,ls",
    "--session-dir", "/results/pi-session",
    "Fix the regression.",
  ]);
});

test("Pi JSON 事件统计工具、失败、步骤、压缩和 token", () => {
  const evidence = parsePiJsonEvents([
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "x.py" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false }),
    JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "pytest -q" } }),
    JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: true }),
    JSON.stringify({ type: "compaction_end", aborted: false, result: { summary: "state" } }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
    }),
  ].join("\n"));

  assert.equal(evidence.steps, 1);
  assert.equal(evidence.toolCalls, 2);
  assert.deepEqual(evidence.toolCallsByName, { bash: 1, read: 1 });
  assert.equal(evidence.toolFailures, 1);
  assert.equal(evidence.verificationCommands, 1);
  assert.equal(evidence.contextCompactions, 1);
  assert.equal(evidence.inputTokens, 10);
  assert.equal(evidence.totalTokens, 14);
});
