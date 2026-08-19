import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DockerSandbox,
  buildWorkerContainerStartArgs,
  type DockerInteractiveProcess,
  type DockerInteractiveRunner,
  type DockerProcessResult,
  type DockerProcessRunner,
} from "../../eval/swebench/docker_sandbox.ts";

const baseOptions = {
  image: "coding-agent-swebench:dev",
  workspace: "/tmp/swebench-task-1/workspace",
  resultDirectory: "/tmp/swebench-task-1/result",
  workerCommand: ["node", "/opt/coding-agent/worker.ts"],
};

test("Worker 容器参数只挂载 task workspace/result，并默认关闭网络", () => {
  const args = buildWorkerContainerStartArgs(baseOptions);

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

test("官方 SWE-bench repo 路径可以挂载到 /testbed", () => {
  const args = buildWorkerContainerStartArgs({
    ...baseOptions,
    containerWorkspace: "/testbed",
    containerResults: "/eval-results",
  });

  assert.ok(args.includes("type=bind,src=/tmp/swebench-task-1/workspace,dst=/testbed"));
  assert.ok(args.includes("type=bind,src=/tmp/swebench-task-1/result,dst=/eval-results"));
});

test("grader 可以额外挂载 Git common dir，但默认 Worker 不会挂载", () => {
  const workerArgs = buildWorkerContainerStartArgs(baseOptions);
  assert.equal(workerArgs.some((arg) => arg.includes(".git")), false);
  const graderArgs = buildWorkerContainerStartArgs({
    ...baseOptions,
    extraMounts: [{
      source: "/private/tmp/sympy/.git",
      target: "/private/tmp/sympy/.git",
    }],
  });
  assert.ok(graderArgs.includes(
    "type=bind,src=/private/tmp/sympy/.git,dst=/private/tmp/sympy/.git",
  ));
});

test("拒绝非绝对路径以及把项目根目录当 task workspace", () => {
  assert.throws(
    () => buildWorkerContainerStartArgs({ ...baseOptions, workspace: "relative/workspace" }),
    /必须是绝对路径/,
  );
  assert.throws(
    () => buildWorkerContainerStartArgs({
      ...baseOptions,
      workspace: "/Users/titusliu/Documents/ai-agent/coding-agent",
      projectRoot: "/Users/titusliu/Documents/ai-agent/coding-agent",
    }),
    /不能是项目根目录/,
  );
});

test("Worker 环境只允许传入非敏感配置，不允许通过环境变量传入凭据", () => {
  const args = buildWorkerContainerStartArgs({
    ...baseOptions,
    workerEnvironment: {
      WORKER_MODEL: "deepseek-test",
      WORKER_SYSTEM_PROMPT_FILE: "/opt/coding-agent/config/prompts/react.md",
    },
  });

  assert.ok(args.includes("WORKER_MODEL=deepseek-test"));
  assert.equal(args.some((arg) => /KEY|TOKEN|SECRET|PASSWORD/i.test(arg)), false);
});

test("Pi Worker 只能透传凭据名称，并显式声明 bridge 网络", () => {
  const args = buildWorkerContainerStartArgs({
    ...baseOptions,
    network: "bridge",
    passthroughEnvironment: ["DEEPSEEK_API_KEY"],
  });

  assert.deepEqual(args.slice(0, 5), ["run", "--rm", "--detach", "--network", "bridge"]);
  assert.ok(args.includes("DEEPSEEK_API_KEY"));
  assert.equal(args.some((arg) => arg.includes("secret-value")), false);
});

test("Docker Sandbox 拒绝未知的凭据透传和网络模式", () => {
  assert.throws(
    () => buildWorkerContainerStartArgs({ ...baseOptions, passthroughEnvironment: ["OPENAI_API_KEY"] }),
    /不允许透传环境变量/,
  );
  assert.throws(
    () => buildWorkerContainerStartArgs({ ...baseOptions, network: "host" as never }),
    /network 只能是 none 或 bridge/,
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

test("Worker 可以使用显式容器工作目录而不通过 shell 拼接", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const sandbox = new DockerSandbox({
    ...baseOptions,
    workerCwd: "/testbed",
    processRunner: async (executable, args) => {
      calls.push({ executable, args });
      return args[0] === "run"
        ? { stdout: "container-123\n", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "", exitCode: 0 };
    },
  });

  await sandbox.runWorker({ taskId: "task-1", problemStatement: "fix" });
  assert.deepEqual(calls[1]?.args, [
    "exec", "-i", "--workdir", "/testbed", "container-123", "node", "/opt/coding-agent/worker.ts",
  ]);
  await sandbox.stop();
});

test("Worker 容器成功启动后只触发一次启动观测回调", async () => {
  let started = 0;
  const sandbox = new DockerSandbox({
    ...baseOptions,
    onWorkerStarted: () => { started += 1; },
    processRunner: async (_executable, args) => args[0] === "run"
      ? { stdout: "container-123\n", stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 },
  });

  await sandbox.start();
  await sandbox.start();
  assert.equal(started, 1);
  await sandbox.stop();
});

test("Worker 通过 docker exec stdin/stdout 往返模型请求", async () => {
  const writes: string[] = [];
  let observedRequest: Record<string, unknown> | undefined;
  const interactiveRunner: DockerInteractiveRunner = (
    executable,
    args,
    onStdoutLine,
  ): DockerInteractiveProcess => {
    assert.equal(executable, "docker");
    assert.deepEqual(args.slice(0, 3), ["exec", "-i", "container-123"]);
    const done = new Promise<DockerProcessResult>((resolve) => {
      setTimeout(async () => {
        const message = {
          type: "model_request",
          request: { model: "deepseek-test" },
        };
        observedRequest = message.request;
        await onStdoutLine(JSON.stringify(message));
        resolve({ stdout: "worker-result\n", stderr: "", exitCode: 0 });
      }, 0);
    });
    return {
      write: (value) => {
        writes.push(value);
      },
      end: () => undefined,
      done,
    };
  };
  const sandbox = new DockerSandbox({
    ...baseOptions,
    processRunner: async (executable, args) => {
      if (args[0] === "run") return { stdout: "container-123\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    interactiveRunner,
    modelProxy: async (request) => ({
      output: [],
      output_text: "model-response",
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      ...request,
    }),
  });

  await sandbox.start();
  const result = await sandbox.runWorker({ taskId: "task-1", problemStatement: "fix" });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(observedRequest, { model: "deepseek-test" });
  assert.match(writes.join(""), /model_response/);
  await sandbox.stop();
});
