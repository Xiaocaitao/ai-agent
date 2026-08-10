import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DockerSandbox,
  buildWorkerContainerArgs,
  type DockerProcessRunner,
} from "../../eval/swebench/docker_sandbox.ts";

const baseOptions = {
  image: "coding-agent-swebench:dev",
  workspace: "/tmp/swebench-task-1/workspace",
  resultDirectory: "/tmp/swebench-task-1/result",
  workerCommand: ["node", "/opt/coding-agent/worker.ts"],
};

test("Worker 容器参数只挂载 task workspace/result，并默认关闭网络", () => {
  const args = buildWorkerContainerArgs(baseOptions);

  assert.deepEqual(args.slice(0, 5), [
    "run",
    "--rm",
    "--detach",
    "--network",
    "none",
  ]);
  assert.ok(args.includes("--cap-drop=ALL"));
  assert.ok(args.includes("--security-opt=no-new-privileges"));
  assert.ok(args.includes("type=bind,src=/tmp/swebench-task-1/workspace,dst=/workspace"));
  assert.ok(args.includes("type=bind,src=/tmp/swebench-task-1/result,dst=/results"));
  assert.equal(args.includes("/Users/titusliu/Documents/ai-agent/coding-agent"), false);
  assert.equal(args.some((arg) => arg.includes("DOCKER_HOST")), false);
  assert.equal(args.some((arg) => arg.includes("API_KEY")), false);
});

test("拒绝非绝对路径以及把项目根目录当 task workspace", () => {
  assert.throws(
    () => buildWorkerContainerArgs({ ...baseOptions, workspace: "relative/workspace" }),
    /必须是绝对路径/,
  );
  assert.throws(
    () => buildWorkerContainerArgs({
      ...baseOptions,
      workspace: "/Users/titusliu/Documents/ai-agent/coding-agent",
      projectRoot: "/Users/titusliu/Documents/ai-agent/coding-agent",
    }),
    /不能是项目根目录/,
  );
});

test("start/runWorker/stop 使用明确的 docker argv，并能清理容器", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const processRunner: DockerProcessRunner = async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "run") return { stdout: "container-123\n", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const sandbox = new DockerSandbox({ ...baseOptions, processRunner });

  const started = await sandbox.start();
  assert.deepEqual(started, {
    containerId: "container-123",
    containerWorkspace: "/workspace",
    resultDirectory: "/results",
  });
  const result = await sandbox.runWorker({ taskId: "demo-task", problemStatement: "修复 bug" });
  assert.equal(result.exitCode, 0);
  await sandbox.stop();

  assert.equal(calls[0]?.executable, "docker");
  assert.equal(calls[0]?.args[0], "run");
  assert.deepEqual(calls[1], {
    executable: "docker",
    args: ["exec", "-i", "container-123", "node", "/opt/coding-agent/worker.ts"],
  });
  assert.deepEqual(calls[2], {
    executable: "docker",
    args: ["rm", "--force", "container-123"],
  });
});
