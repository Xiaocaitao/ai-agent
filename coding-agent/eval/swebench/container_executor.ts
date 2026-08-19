import { spawn } from "node:child_process";

import { truncate } from "../../tools/_common.ts";
import type { CommandData, CommandExecutor } from "../../tools/run_command.ts";

const WORKER_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "CI",
]);

function workerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && WORKER_ENVIRONMENT.has(name)) {
      environment[name] = value;
    }
  }
  return environment;
}

/**
 * Docker Worker 内的命令执行器。
 * Docker 容器已经是隔离边界，因此这里不再调用 macOS sandbox-exec；
 * 仍然使用 shell: false、最小环境和超时，避免工具自行扩大权限。
 */
export function createContainerCommandExecutor(): CommandExecutor {
  return async (args, stdin, timeout, cwd): Promise<CommandData> => {
    const [executable, ...commandArgs] = args;
    if (!executable) {
      throw new Error("容器命令不能为空");
    }
    return await new Promise<CommandData>((resolve, reject) => {
      const child = spawn(executable, commandArgs, {
        cwd,
        env: workerEnvironment(),
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        const stdoutText = Buffer.concat(stdout).toString("utf8");
        const stderrText = Buffer.concat(stderr).toString("utf8");
        const [safeStdout, stdoutTruncated] = truncate(stdoutText);
        const [safeStderr, stderrTruncated] = truncate(stderrText);
        resolve({
          stdout: safeStdout,
          stderr: safeStderr,
          exit_code: timedOut ? null : exitCode,
          timed_out: timedOut,
          truncated: stdoutTruncated || stderrTruncated,
          sandboxed: true,
        });
      });
      child.stdin.end(stdin ?? undefined);
    });
  };
}
