import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildWorkerEnvironment,
  runDockerTask,
} from "../../eval/swebench/runner.ts";

test("Worker 环境只包含非敏感运行参数，并能使用官方 /testbed 路径", () => {
  assert.deepEqual(
    buildWorkerEnvironment({
      provider: {
        AGENT_API_KEY: "secret-must-not-be-exported",
        base_url: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        context_window: 100_000,
      },
      prompt: "prompt",
      maxSteps: 7,
    }, { containerWorkspace: "/testbed", containerResults: "/eval-results" }),
    {
      WORKER_MODEL: "deepseek-v4-flash",
      WORKER_SYSTEM_PROMPT_FILE: "/opt/coding-agent/config/prompts/react.md",
      WORKER_MAX_STEPS: "7",
      WORKER_CONTEXT_WINDOW: "100000",
      WORKER_WORKSPACE: "/testbed",
      WORKER_STATE_DATABASE: "/eval-results/session.sqlite",
    },
  );
});

test("runDockerTask 在启动 bind mount 前创建结果目录", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swebench-runner-"));
  const workspace = path.join(root, "workspace");
  const results = path.join(root, "results");
  const runtime = {
    provider: {
      AGENT_API_KEY: "fake",
      base_url: "https://api.deepseek.com",
      model: "test-model",
      context_window: 1_000,
    },
    prompt: "prompt",
    maxSteps: 1,
  };
  const result = await runDockerTask({
    runtime,
    input: { taskId: "task-1", problemStatement: "fix" },
    image: "worker:test",
    workspace,
    resultDirectory: results,
    workerCommand: ["worker"],
    modelProxy: async () => ({ output: [], output_text: "ok", status: "completed" }),
    processRunner: async (_executable, args) =>
      args[0] === "run"
        ? { stdout: "container-1\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
    interactiveRunner: () => ({
      write: () => undefined,
      end: () => undefined,
      done: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    }),
  });
  assert.equal(result.exitCode, 0);
  await stat(results);
});

test("runDockerTask 实时转发 Worker trace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swebench-trace-"));
  const traces: string[] = [];
  const result = await runDockerTask({
    runtime: {
      provider: {
        AGENT_API_KEY: "fake",
        base_url: "https://api.deepseek.com",
        model: "test-model",
        context_window: 1_000,
      },
      prompt: "prompt",
      maxSteps: 1,
    },
    input: { taskId: "task-1", problemStatement: "fix" },
    image: "worker:test",
    workspace: root,
    resultDirectory: path.join(root, "results"),
    workerCommand: ["worker"],
    modelProxy: async () => ({ output: [], output_text: "ok", status: "completed" }),
    traceOutput: (line) => traces.push(line),
    processRunner: async (_executable, args) =>
      args[0] === "run"
        ? { stdout: "container-1\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 },
    interactiveRunner: (_executable, _args, _onStdoutLine, onStderrLine) => {
      onStderrLine?.("[Step 1/1] → 请求模型");
      return {
        write: () => undefined,
        end: () => undefined,
        done: Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(traces, ["[Step 1/1] → 请求模型"]);
});
