import assert from "node:assert/strict";
import test from "node:test";

import {
  runPreflight,
  type PreflightCommandResult,
} from "../../eval/swebench/preflight.ts";

function successfulRunner(
  overrides: Record<string, PreflightCommandResult> = {},
) {
  return async (command: string, args: string[]): Promise<PreflightCommandResult> => {
    const key = `${command} ${args.join(" ")}`;
    return overrides[key] ?? {
      exitCode: 0,
      stdout: command === "docker"
        ? args[0] === "version" ? "29.4.0\n" : "arm64\n"
        : "4.1.0\n",
      stderr: "",
    };
  };
}

test("预检成功时返回结构化 Docker 和 SWE-bench 元数据", async () => {
  const result = await runPreflight({
    pythonPath: "/opt/venv/bin/python",
    runCommand: successfulRunner(),
  });

  assert.deepEqual(result, {
    ok: true,
    pythonPath: "/opt/venv/bin/python",
    swebenchVersion: "4.1.0",
    dockerServer: "29.4.0",
    architecture: "arm64",
  });
});

test("Docker daemon 不可用时返回稳定的 docker_unavailable 错误", async () => {
  const result = await runPreflight({
    pythonPath: "/opt/venv/bin/python",
    runCommand: successfulRunner({
      "docker version --format {{.Server.Version}}": {
        exitCode: null,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon",
        error: "docker unavailable",
      },
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    code: "docker_unavailable",
    detail: "docker unavailable",
  });
});

test("Python 缺少 SWE-bench 包时返回稳定的 swebench_package_missing 错误", async () => {
  const result = await runPreflight({
    pythonPath: "/opt/venv/bin/python",
    runCommand: successfulRunner({
      "/opt/venv/bin/python -c import swebench; print(swebench.__version__)": {
        exitCode: 1,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'swebench'",
      },
    }),
  });

  assert.deepEqual(result, {
    ok: false,
    code: "swebench_package_missing",
    detail: "ModuleNotFoundError: No module named 'swebench'",
  });
});
