import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type PreflightCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  error?: string;
};

export type PreflightCommandRunner = (
  command: string,
  args: string[],
) => Promise<PreflightCommandResult>;

export type PreflightOptions = {
  pythonPath: string;
  runCommand?: PreflightCommandRunner;
};

export type PreflightResult =
  | {
    ok: true;
    pythonPath: string;
    swebenchVersion: string;
    dockerServer: string;
    architecture: string;
  }
  | {
    ok: false;
    code: "swebench_package_missing" | "docker_unavailable";
    detail: string;
  };

const SWEbench_VERSION_SCRIPT =
  "import swebench; print(swebench.__version__)";

const defaultRunner: PreflightCommandRunner = async (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout,
        stderr,
        timedOut,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut });
    });
  });

function failureDetail(result: PreflightCommandResult): string {
  return result.error ??
    (result.stderr.trim() || `退出码: ${result.exitCode ?? "unknown"}`);
}

export async function runPreflight(
  options: PreflightOptions,
): Promise<PreflightResult> {
  const runCommand = options.runCommand ?? defaultRunner;
  const python = await runCommand(options.pythonPath, [
    "-c",
    SWEbench_VERSION_SCRIPT,
  ]);
  if (python.timedOut || python.error !== undefined || python.exitCode !== 0) {
    return {
      ok: false,
      code: "swebench_package_missing",
      detail: failureDetail(python),
    };
  }

  const dockerVersion = await runCommand("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (
    dockerVersion.timedOut ||
    dockerVersion.error !== undefined ||
    dockerVersion.exitCode !== 0
  ) {
    return {
      ok: false,
      code: "docker_unavailable",
      detail: failureDetail(dockerVersion),
    };
  }

  const dockerInfo = await runCommand("docker", [
    "info",
    "--format",
    "{{.Architecture}}",
  ]);
  if (
    dockerInfo.timedOut ||
    dockerInfo.error !== undefined ||
    dockerInfo.exitCode !== 0
  ) {
    return {
      ok: false,
      code: "docker_unavailable",
      detail: failureDetail(dockerInfo),
    };
  }

  const swebenchVersion = python.stdout.trim();
  const dockerServer = dockerVersion.stdout.trim();
  const architecture = dockerInfo.stdout.trim();
  if (swebenchVersion === "" || dockerServer === "" || architecture === "") {
    return {
      ok: false,
      code: "docker_unavailable",
      detail: "预检命令返回空版本或架构",
    };
  }

  return {
    ok: true,
    pythonPath: options.pythonPath,
    swebenchVersion,
    dockerServer,
    architecture,
  };
}

function parseArguments(values: string[]): { pythonPath: string; json: boolean } {
  let pythonPath = "python3";
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--python") {
      const next = values[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("参数 --python 缺少值");
      }
      pythonPath = next;
      index += 1;
      continue;
    }
    if (value === "--json") {
      if (json) throw new Error("重复参数: --json");
      json = true;
      continue;
    }
    throw new Error(`未知参数: ${value}`);
  }
  return { pythonPath, json };
}

const isMainModule = import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    const argumentsValue = parseArguments(process.argv.slice(2));
    const result = await runPreflight(argumentsValue);
    if (argumentsValue.json) {
      console.log(JSON.stringify(result));
    } else if (result.ok) {
      console.log(`SWE-bench ${result.swebenchVersion} / Docker ${result.dockerServer} / ${result.architecture}`);
    } else {
      console.error(`${result.code}: ${result.detail}`);
    }
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
