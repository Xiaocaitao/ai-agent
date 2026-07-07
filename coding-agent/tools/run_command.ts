import { spawn } from "node:child_process";
import path from "node:path";

import { failure, success, truncate, workspacePath } from "./_common.ts";

const DELETE_COMMANDS = new Set(["rm", "rmdir", "unlink", "del", "rd", "remove-item"]);

type CommandData = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

export async function runCommand(args: unknown, stdin: unknown = null, cwd = ".", timeout = 30) {
  if (!Array.isArray(args) || args.length === 0 || !args.every((item) => typeof item === "string")) {
    return failure("args 必须是非空字符串数组");
  }
  if (stdin !== null && typeof stdin !== "string") return failure("stdin 必须是字符串或 null");
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
    return failure("timeout 必须在 1 到 120 秒之间");
  }
  const executable = path.basename(args[0] as string).toLocaleLowerCase();
  if (DELETE_COMMANDS.has(executable) || (executable === "git" && args[1]?.toLocaleLowerCase() === "clean")) {
    return failure("终端工具不允许执行文件删除命令");
  }

  try {
    const [workdir, relativeCwd] = await workspacePath(cwd);
    const result = await new Promise<CommandData>((resolve, reject) => {
      const child = spawn(args[0] as string, args.slice(1) as string[], { cwd: workdir, shell: false });
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
        const [out, outTruncated] = truncate(Buffer.concat(stdout).toString("utf8"));
        const [err, errTruncated] = truncate(Buffer.concat(stderr).toString("utf8"));
        resolve({ stdout: out, stderr: err, exit_code: timedOut ? null : code, timed_out: timedOut, truncated: outTruncated || errTruncated });
      });
      if (stdin !== null) child.stdin.end(stdin as string);
      else child.stdin.end();
    });
    if (result.timed_out) return failure(`命令执行超时: ${timeout} 秒`, result);
    if (result.exit_code !== 0) return failure(`命令退出码: ${result.exit_code}`, result);
    return success(result);
  } catch (error) {
    return failure(error);
  }
}

export const run_command = ({ args, stdin = null, cwd = ".", timeout = 30 }: Record<string, unknown>) =>
  runCommand(args, stdin, String(cwd), Number(timeout));
