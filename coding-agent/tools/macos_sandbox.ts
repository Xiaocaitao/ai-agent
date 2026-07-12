import { accessSync, constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec" as const;
export const MACOS_SANDBOX_PROFILE = path.resolve(
  import.meta.dirname,
  "../sandbox/macos-workspace.sb",
);

const AGENT_CONFIG_DIR = path.resolve(import.meta.dirname, "../config");
const SAFE_ENVIRONMENT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
]);

export type SandboxedCommand = {
  executable: typeof MACOS_SANDBOX_EXECUTABLE;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function assertMacOsSandboxAvailable(
  executable = MACOS_SANDBOX_EXECUTABLE,
  profile = MACOS_SANDBOX_PROFILE,
): void {
  if (process.platform !== "darwin")
    throw new Error("OS 沙箱当前只支持 macOS");
  accessSync(executable, constants.X_OK);
  accessSync(profile, constants.R_OK);
}

export function sanitizeChildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      (SAFE_ENVIRONMENT.has(name) || name.startsWith("LC_"))
    ) {
      result[name] = value;
    }
  }
  result.TMPDIR = "/private/tmp";
  return result;
}

export function buildSandboxedCommand(
  command: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): SandboxedCommand {
  assertMacOsSandboxAvailable();
  if (command.length === 0) throw new Error("沙箱命令不能为空");

  const workspace = realpathSync(cwd);
  const home = realpathSync(homedir());
  const gitDir = path.join(workspace, ".git");

  return {
    executable: MACOS_SANDBOX_EXECUTABLE,
    args: [
      "-D",
      `HOME_DIR=${home}`,
      "-D",
      `WORKSPACE=${workspace}`,
      "-D",
      `SSH_DIR=${path.join(home, ".ssh")}`,
      "-D",
      `AWS_DIR=${path.join(home, ".aws")}`,
      "-D",
      `AGENT_CONFIG_DIR=${AGENT_CONFIG_DIR}`,
      "-D",
      `WORKSPACE_ENV=${path.join(workspace, ".env")}`,
      "-D",
      `GIT_HOOKS=${path.join(gitDir, "hooks")}`,
      "-D",
      `GIT_CONFIG=${path.join(gitDir, "config")}`,
      "-D",
      `SANDBOX_PROFILE=${MACOS_SANDBOX_PROFILE}`,
      "-f",
      MACOS_SANDBOX_PROFILE,
      ...command,
    ],
    env: sanitizeChildEnvironment(environment),
  };
}
