import { spawn } from "node:child_process";

import { failure, success, truncate, workspacePath } from "./_common.ts";
import { buildSandboxedCommand } from "./macos_sandbox.ts";
import { commandPolicy } from "./permissions.ts";

export type PreparedCommand = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
};

type CommandData = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
  sandboxed: boolean;
  sandbox_denied?: true;
};

function isSandboxDenial(stderr: string): boolean {
  return /Operation not permitted|sandbox_apply|Sandbox: .*deny/i.test(stderr);
}

// 只负责执行已经准备好的程序和 argv；权限与沙箱策略由上层 runCommand 决定。
export async function executePreparedCommand(
  command: PreparedCommand,
  stdin: string | null,
  timeout: number,
  cwd: string,
) {
  try {
    const result = await new Promise<CommandData>((resolve, reject) => {
      const child = spawn(command.executable, command.args, {
        cwd,
        env: command.env,
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", reject);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);
      child.on("close", (code) => {
        clearTimeout(timer);
        const [out, outTruncated] = truncate(
          Buffer.concat(stdout).toString("utf8"),
        );
        const stderrText = Buffer.concat(stderr).toString("utf8");
        const [err, errTruncated] = truncate(stderrText);
        resolve({
          stdout: out,
          stderr: err,
          exit_code: timedOut ? null : code,
          timed_out: timedOut,
          truncated: outTruncated || errTruncated,
          sandboxed: command.sandboxed,
          ...(command.sandboxed && isSandboxDenial(stderrText)
            ? { sandbox_denied: true }
            : {}),
        });
      });
      if (stdin !== null) child.stdin.end(stdin);
      else child.stdin.end();
    });
    if (result.timed_out)
      return failure(`命令执行超时: ${timeout} 秒`, result);
    if (result.exit_code !== 0)
      return failure(`命令退出码: ${result.exit_code}`, result);
    return success(result);
  } catch (error) {
    return failure(error);
  }
}

export async function runCommand(
  args: unknown,
  stdin: unknown = null,
  cwd = ".",
  timeout = 30,
) {
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    !args.every((item) => typeof item === "string")
  ) {
    return failure("args 必须是非空字符串数组");
  }
  if (stdin !== null && typeof stdin !== "string")
    return failure("stdin 必须是字符串或 null");
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    timeout < 1 ||
    timeout > 120
  ) {
    return failure("timeout 必须在 1 到 120 秒之间");
  }
  // Handler 层复用权限分类器做第二次检查，避免未来直接调用 runCommand 时绕过上游权限门。
  const policy = commandPolicy(args as string[]);
  if (policy.dangerous) return failure(policy.reason ?? "终端工具不允许执行危险命令");

  try {
    const [workdir] = await workspacePath(cwd);
    const command = buildSandboxedCommand(args as string[], workdir);
    return executePreparedCommand(
      command,
      stdin as string | null,
      timeout,
      workdir,
    );
  } catch (error) {
    return failure(error);
  }
}

export const run_command = ({
  args,
  stdin = null,
  cwd = ".",
  timeout = 30,
}: Record<string, unknown>) =>
  runCommand(args, stdin, String(cwd), Number(timeout));
