# macOS OS Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `run_command` 启动的命令放入 macOS Seatbelt 沙箱，限制工作区外文件访问、敏感文件读取、子进程网络和本机 IPC，同时保留现有 Allow / Ask / Deny 语义。

**Architecture:** `ToolRegistry` 和 `PermissionEngine` 保持不变；权限通过后，`run_command` 不再直接 `spawn` 模型提供的程序，而是构造 `/usr/bin/sandbox-exec -D ... -f ... <command...>`。固定 SBPL 文件表达安全边界，TypeScript 模块只负责路径参数、最小环境变量和启动前检查。

**Tech Stack:** Node.js 22.18+、TypeScript、`node:child_process.spawn`、macOS `/usr/bin/sandbox-exec`、SBPL、`node:test`；不新增 npm 依赖。

## Global Constraints

- 首版只支持 macOS；其他平台启动时明确失败。
- 使用原生 `/usr/bin/sandbox-exec`，不使用 SRT、Docker 或第三方沙箱库。
- Profile 使用 `deny default`，网络、Apple Events、任意 Unix Socket 默认不开放。
- 用户批准工具只代表允许尝试执行，不能扩大 Seatbelt 边界。
- 沙箱不可用、Profile 缺失或参数构造失败时 fail closed，禁止退回裸 `spawn`。
- 原始命令始终保持 argv 数组；不拼接 Shell 字符串，外层始终 `shell: false`。
- 首版不实现域名白名单、动态扩权、Linux 抽象、CPU/内存/磁盘配额和进程组超时清理。
- 自动化集成测试必须显式设置 `RUN_MACOS_SANDBOX_TESTS=1`，避免在 Codex 等已经受限的宿主沙箱中嵌套运行 Seatbelt。

---

## File Map

- Create `sandbox/macos-workspace.sb`: 固定 Seatbelt 策略，只通过 `-D` 接收规范化绝对路径。
- Create `tools/macos_sandbox.ts`: 检查运行环境、清理环境变量、构造 `sandbox-exec` argv。
- Modify `tools/run_command.ts`: 将唯一的裸 `spawn` 替换成沙箱命令，并返回沙箱状态。
- Modify `cli.ts`: CLI 启动时预检 macOS、`sandbox-exec` 和 Profile。
- Create `tests/macos_sandbox.test.ts`: 纯构造与环境变量单元测试。
- Modify `tests/tools.test.ts`: 保留命令工具原行为，并验证它实际使用沙箱。
- Create `tests/macos_sandbox.integration.test.ts`: opt-in 的真实 Seatbelt 边界测试。
- Modify `package.json`: 增加显式 macOS 沙箱集成测试脚本。
- Modify `README.md` and `doc/安全与权限/3.macOS-OS沙箱设计.md`: 更新启用方式、状态和能力边界。

---

### Task 1: 固定 Seatbelt Profile 与纯命令构造器

**Files:**
- Create: `sandbox/macos-workspace.sb`
- Create: `tools/macos_sandbox.ts`
- Create: `tests/macos_sandbox.test.ts`

**Interfaces:**
- Produces: `assertMacOsSandboxAvailable()`, `sanitizeChildEnvironment(env)`, `buildSandboxedCommand(command, cwd, env?)`。
- Produces type:

```ts
export type SandboxedCommand = {
  executable: "/usr/bin/sandbox-exec";
  args: string[];
  env: NodeJS.ProcessEnv;
};
```

- [ ] **Step 1: 写 Profile 存在性、argv 保真和环境清理的失败测试**

创建 `tests/macos_sandbox.test.ts`：

```ts
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  MACOS_SANDBOX_EXECUTABLE,
  MACOS_SANDBOX_PROFILE,
  assertMacOsSandboxAvailable,
  buildSandboxedCommand,
  sanitizeChildEnvironment,
} from "../tools/macos_sandbox.ts";

test("macOS 沙箱依赖存在", () => {
  assert.doesNotThrow(() => assertMacOsSandboxAvailable());
  assert.equal(MACOS_SANDBOX_EXECUTABLE, "/usr/bin/sandbox-exec");
  assert.equal(path.basename(MACOS_SANDBOX_PROFILE), "macos-workspace.sb");
});

test("沙箱命令保持原始 argv，不引入外层 Shell", () => {
  const cwd = path.resolve(import.meta.dirname, "..");
  const original = ["/bin/echo", "a b", ";", "$(touch bad)", "line1\nline2"];
  const command = buildSandboxedCommand(original, cwd, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/demo",
    AGENT_API_KEY: "secret",
  });

  assert.equal(command.executable, "/usr/bin/sandbox-exec");
  assert.deepEqual(command.args.slice(-original.length), original);
  assert.equal(command.env.AGENT_API_KEY, undefined);
  assert.equal(command.env.PATH, "/usr/bin:/bin");
  assert.equal(command.env.TMPDIR, "/private/tmp");
});

test("子进程环境只保留必要变量", () => {
  const env = sanitizeChildEnvironment({
    PATH: "/usr/bin:/bin",
    HOME: "/Users/demo",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    AGENT_API_KEY: "a",
    OPENAI_API_KEY: "b",
    GITHUB_TOKEN: "c",
    DATABASE_PASSWORD: "d",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    HTTP_PROXY: "http://user:pass@example.com",
  });

  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/demo",
    LANG: "zh_CN.UTF-8",
    LC_ALL: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: "/private/tmp",
  });
});
```

- [ ] **Step 2: 运行测试并确认因模块不存在而失败**

Run:

```bash
node --experimental-strip-types --test tests/macos_sandbox.test.ts
```

Expected: FAIL，错误包含 `Cannot find module '../tools/macos_sandbox.ts'`。

- [ ] **Step 3: 创建固定 SBPL**

创建 `sandbox/macos-workspace.sb`：

```scheme
(version 1)
(deny default)

; 允许执行目标程序及其后代，但限制只能操作同一沙箱中的进程。
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; v1 为兼容 macOS 动态链接器和 CLI，允许读取非用户目录；
; 用户主目录先拒绝，再仅重新开放工作区。
(allow file-read*)
(deny file-read* (subpath (param "HOME_DIR")))
(allow file-read* (subpath (param "WORKSPACE")))

; 无论工作区是否覆盖这些路径，敏感资源最终保持不可读。
(deny file-read* (subpath (param "SSH_DIR")))
(deny file-read* (subpath (param "AWS_DIR")))
(deny file-read* (subpath (param "AGENT_CONFIG_DIR")))
(deny file-read* (literal (param "WORKSPACE_ENV")))

; 只允许工作区和固定临时目录写入。
(allow file-write* (subpath (param "WORKSPACE")))
(allow file-write* (subpath "/private/tmp"))

; 工作区内也不能改写可扩大下一次运行权限的配置。
(deny file-write* (subpath (param "GIT_HOOKS")))
(deny file-write* (literal (param "GIT_CONFIG")))
(deny file-write* (subpath (param "AGENT_CONFIG_DIR")))
(deny file-write* (literal (param "SANDBOX_PROFILE")))
(deny file-write* (literal (param "WORKSPACE_ENV")))

; Node、Python 和常用 CLI 的最小运行能力。
(allow sysctl-read)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow mach-lookup
  (global-name "com.apple.logd")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership"))

; 故意不开放 network*、system-socket、appleevent-send 和 lsopen。
```

- [ ] **Step 4: 实现最小 TypeScript 构造器**

创建 `tools/macos_sandbox.ts`：

```ts
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
    if (value !== undefined && (SAFE_ENVIRONMENT.has(name) || name.startsWith("LC_")))
      result[name] = value;
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
      "-D", `HOME_DIR=${home}`,
      "-D", `WORKSPACE=${workspace}`,
      "-D", `SSH_DIR=${path.join(home, ".ssh")}`,
      "-D", `AWS_DIR=${path.join(home, ".aws")}`,
      "-D", `AGENT_CONFIG_DIR=${AGENT_CONFIG_DIR}`,
      "-D", `WORKSPACE_ENV=${path.join(workspace, ".env")}`,
      "-D", `GIT_HOOKS=${path.join(gitDir, "hooks")}`,
      "-D", `GIT_CONFIG=${path.join(gitDir, "config")}`,
      "-D", `SANDBOX_PROFILE=${MACOS_SANDBOX_PROFILE}`,
      "-f", MACOS_SANDBOX_PROFILE,
      ...command,
    ],
    env: sanitizeChildEnvironment(environment),
  };
}
```

- [ ] **Step 5: 运行单元测试**

Run:

```bash
node --experimental-strip-types --test tests/macos_sandbox.test.ts
npm run typecheck
```

Expected: sandbox unit tests PASS；TypeScript PASS。

- [ ] **Step 6: 提交纯策略与构造器**

```bash
git add sandbox/macos-workspace.sb tools/macos_sandbox.ts tests/macos_sandbox.test.ts
git commit -m "feat: add macOS Seatbelt command builder"
```

---

### Task 2: 将 run_command 接入 Seatbelt

**Files:**
- Modify: `tools/run_command.ts`
- Modify: `tests/tools.test.ts`

**Interfaces:**
- Consumes: `buildSandboxedCommand(command: string[], cwd: string, env?: NodeJS.ProcessEnv): SandboxedCommand`。
- Produces internal test seam `executePreparedCommand(command, stdin, timeout)`；生产入口 `runCommand` 始终先调用 `buildSandboxedCommand`，不存在关闭沙箱的配置开关。
- Extends production command result with `sandboxed: true` and optional `sandbox_denied: true`。

- [ ] **Step 1: 将现有进程 I/O 测试改为测试已准备命令执行器**

在 `tests/tools.test.ts` 中从 `tools/run_command.ts` 直接导入尚未实现的测试缝：

```ts
import { executePreparedCommand } from "../tools/run_command.ts";

function directCommand(args: string[]) {
  return {
    executable: args[0],
    args: args.slice(1),
    env: process.env,
    sandboxed: false,
  };
}
```

将现有“stdin/stdout、非零退出码、超时、截断、Shell 操作符不解释”的测试从 `runCommand(args, ...)` 改为：

```ts
const result = await executePreparedCommand(
  directCommand([process.execPath, "-e", "console.log('ok')"]),
  null,
  30,
);
```

保留危险命令二次检查测试直接调用生产入口，因为这些调用会在构造沙箱前返回：

```ts
assert.equal((await runCommand(["rm", "file.txt"])).ok, false);
assert.equal((await runCommand(["bash", "-c", "rm file.txt"])).ok, false);
```

再增加执行器 argv 保真测试：

```ts
test("executePreparedCommand 不使用外层 Shell", async () => {
  const root = await temporaryDirectory();
  const result = await executePreparedCommand(
    directCommand([
      process.execPath,
      "-e",
      "console.log(process.argv.slice(1))",
      ";",
      "$(touch should-not-exist)",
    ]),
    null,
    30,
    root,
  );

  assert.equal(result.ok, true);
  assert.equal(result.data.sandboxed, false);
  assert.match(String(result.data.stdout), /\$\(touch should-not-exist\)/);
  await assert.rejects(() => readFile(path.join(root, "should-not-exist")));
});
```

- [ ] **Step 2: 运行测试并确认执行器尚不存在**

Run:

```bash
node --experimental-strip-types --test tests/tools.test.ts
```

Expected: FAIL，包含 `does not provide an export named 'executePreparedCommand'`。

- [ ] **Step 3: 抽出无策略判断的已准备命令执行器**

在 `tools/run_command.ts`：

```ts
import { buildSandboxedCommand } from "./macos_sandbox.ts";

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
```

把当前 Promise、stdin、timeout、输出收集和截断逻辑原样移动到：

```ts
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
```

其中唯一的 `spawn` 必须是：

```ts
const child = spawn(command.executable, command.args, {
  cwd,
  env: command.env,
  shell: false,
});
```

上述结果使用传入描述符的 `sandboxed`，只有生产沙箱命令才判断 Seatbelt 拒绝：

```ts
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
```

- [ ] **Step 4: 让生产 runCommand 强制构造 Seatbelt 命令**

`SandboxedCommand` 增加固定字段：

```ts
export type SandboxedCommand = {
  executable: typeof MACOS_SANDBOX_EXECUTABLE;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: true;
};
```

`buildSandboxedCommand` 返回值增加：

```ts
sandboxed: true,
```

`runCommand` 完成参数和危险命令校验后只能走：

```ts
const [workdir] = await workspacePath(cwd);
const command = buildSandboxedCommand(args as string[], workdir);
return executePreparedCommand(command, stdin as string | null, timeout, workdir);
```

不要给 `runCommand` 增加 `disableSandbox`、可选 builder 或环境变量旁路；测试缝只位于更低层的 `executePreparedCommand`，不负责权限和沙箱策略。

- [ ] **Step 5: 运行命令工具回归测试**

Run:

```bash
node --experimental-strip-types --test tests/tools.test.ts
npm run typecheck
```

Expected: PASS。常规单元测试只执行预先准备的测试命令，不嵌套 Seatbelt；真实 `runCommand` 边界留给 Task 4 的 opt-in 测试。

- [ ] **Step 6: 提交 run_command 接入**

```bash
git add tools/run_command.ts tests/tools.test.ts
git commit -m "feat: run commands inside macOS Seatbelt"
```

---

### Task 3: CLI 启动预检与 fail-closed 行为

**Files:**
- Modify: `cli.ts`
- Modify: `tests/macos_sandbox.test.ts`

**Interfaces:**
- Consumes: `assertMacOsSandboxAvailable(executable?, profile?): void`。
- Behavior: 工作区解析成功后、读取模型配置和进入 REPL 前验证平台、可执行文件和 Profile。

- [ ] **Step 1: 增加不可用依赖的失败测试**

在 `tests/macos_sandbox.test.ts` 增加：

```ts
test("sandbox-exec 或 Profile 缺失时 fail closed", () => {
  assert.throws(
    () => assertMacOsSandboxAvailable("/missing/sandbox-exec", MACOS_SANDBOX_PROFILE),
    /ENOENT/,
  );
  assert.throws(
    () => assertMacOsSandboxAvailable(MACOS_SANDBOX_EXECUTABLE, "/missing/profile.sb"),
    /ENOENT/,
  );
});
```

- [ ] **Step 2: 在 CLI 启动链加入预检**

在 `cli.ts` 导入：

```ts
import { assertMacOsSandboxAvailable } from "./tools/macos_sandbox.ts";
```

在 `runCli()` 中保持工作区错误优先级，然后立即预检：

```ts
const workspace = configureWorkspace(process.argv[2] ?? ".");
assertMacOsSandboxAvailable();
const runtime = await loadRuntime();
```

这样 macOS 不支持、`sandbox-exec` 缺失或 Profile 不可读都会进入 `agent.ts` 现有的“配置错误”退出路径，进程不会进入 REPL，也不会执行裸命令。

- [ ] **Step 3: 运行 CLI 与单元测试**

Run:

```bash
node --experimental-strip-types --test tests/macos_sandbox.test.ts tests/cli.test.ts
npm run typecheck
```

Expected: PASS；原有“无效工作目录”错误文本保持不变。

- [ ] **Step 4: 提交启动预检**

```bash
git add cli.ts tests/macos_sandbox.test.ts
git commit -m "feat: fail closed when macOS sandbox is unavailable"
```

---

### Task 4: 真实 macOS 边界验收与文档收尾

**Files:**
- Create: `tests/macos_sandbox.integration.test.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `doc/安全与权限/3.macOS-OS沙箱设计.md`

**Interfaces:**
- Consumes: public `runCommand` and `configureWorkspace`。
- Produces: opt-in script `npm run test:sandbox`。

- [ ] **Step 1: 创建 opt-in 集成测试入口**

创建 `tests/macos_sandbox.integration.test.ts`，顶部统一跳过条件：

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configureWorkspace, runCommand } from "../tools/index.ts";

const enabled =
  process.platform === "darwin" &&
  process.env.RUN_MACOS_SANDBOX_TESTS === "1";

test("Seatbelt 允许工作区写入并拒绝用户目录越界", { skip: !enabled }, async () => {
  const root = await mkdtemp(path.join(homedir(), ".coding-agent-sandbox-"));
  const workspace = path.join(root, "workspace");
  const outside = path.join(root, "outside.txt");
  const inside = path.join(workspace, "inside.txt");
  await mkdir(workspace, { recursive: false });
  await writeFile(outside, "outside");
  configureWorkspace(workspace);

  try {
    const allowed = await runCommand([
      "/bin/sh", "-c", "echo inside > inside.txt",
    ]);
    assert.equal(allowed.ok, true);
    assert.equal(await readFile(inside, "utf8"), "inside\n");

    const denied = await runCommand([
      "/bin/sh", "-c", `echo changed > ${JSON.stringify(outside)}`,
    ]);
    assert.equal(denied.ok, false);
    assert.equal(denied.data.sandbox_denied, true);
    assert.equal(await readFile(outside, "utf8"), "outside");
  } finally {
    try { await unlink(inside); } catch {}
    await unlink(outside);
    await rmdir(workspace);
    await rmdir(root);
  }
});

test("Seatbelt 限制继承给多层子进程", { skip: !enabled }, async () => {
  const workspace = path.resolve(import.meta.dirname, "..");
  configureWorkspace(workspace);
  const result = await runCommand([
    "/bin/sh",
    "-c",
    "python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.com\", timeout=2)'",
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.data.sandboxed, true);
});
```

测试清理只能逐个 `unlink` 明确文件，再对已经为空的目录调用非递归 `rmdir`；禁止递归删除。

- [ ] **Step 2: 增加显式测试脚本**

在 `package.json` 的 `scripts` 中增加：

```json
"test:sandbox": "RUN_MACOS_SANDBOX_TESTS=1 node --experimental-strip-types --test tests/macos_sandbox.integration.test.ts"
```

- [ ] **Step 3: 从未被其他沙箱包裹的普通 Terminal 运行真实验收**

Run:

```bash
npm run test:sandbox
```

Expected: 工作区写入 PASS、工作区外写入 PASS（即被正确拒绝）、多层子进程网络测试 PASS。

再进行两条人工验证：

```bash
node --experimental-strip-types agent.ts /path/to/test-workspace
```

向 Agent 请求普通 `ls`，批准后应成功；请求 `curl https://example.com`，批准后应返回沙箱拒绝。使用无副作用命令验证 Apple Events：

```bash
/usr/bin/sandbox-exec \
  -D "HOME_DIR=$HOME" \
  -D "WORKSPACE=$PWD" \
  -D "SSH_DIR=$HOME/.ssh" \
  -D "AWS_DIR=$HOME/.aws" \
  -D "AGENT_CONFIG_DIR=$PWD/config" \
  -D "WORKSPACE_ENV=$PWD/.env" \
  -D "GIT_HOOKS=$PWD/.git/hooks" \
  -D "GIT_CONFIG=$PWD/.git/config" \
  -D "SANDBOX_PROFILE=$PWD/sandbox/macos-workspace.sb" \
  -f "$PWD/sandbox/macos-workspace.sb" \
  /usr/bin/osascript -e 'tell application "Finder" to get name of startup disk'
```

Expected: Apple Events 或所需 IPC 被拒绝，不弹出并完成 Finder 自动化操作。

- [ ] **Step 4: 更新文档状态与使用说明**

在 `README.md` 的功能列表和更新日志增加：

- `run_command` 在 macOS Seatbelt 中执行；
- 工作区外读写和子进程网络默认禁止；
- 仅支持 macOS；
- `npm run test:sandbox` 必须从普通 Terminal 执行；
- `allow / ask / deny` 与 OS Sandbox 是两层机制。

在 `doc/安全与权限/3.macOS-OS沙箱设计.md`：

- 将“尚未实现”改为“macOS 首版已实现”；
- 记录实际 Profile 白名单、环境变量白名单和测试结果；
- 明确 v1 读取策略是“允许非用户目录、拒绝 HOME、重新允许 WORKSPACE”，不是完整容器文件系统；
- 保留 CPU、内存、磁盘配额和动态扩权不在范围内的说明。

- [ ] **Step 5: 运行全部非嵌套验证**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS。若运行环境本身阻止嵌套 `sandbox-exec`，常规测试不得误降级执行命令；应明确报告 `sandbox_apply: Operation not permitted`，真实集成测试在普通 Terminal 单独完成。

- [ ] **Step 6: 提交集成测试与文档**

```bash
git add tests/macos_sandbox.integration.test.ts package.json README.md 'doc/安全与权限/3.macOS-OS沙箱设计.md'
git commit -m "test: verify macOS sandbox boundaries"
```

---

## Final Acceptance

- [ ] 所有 `run_command` 调用在权限通过后都经过 `/usr/bin/sandbox-exec`。
- [ ] 不存在从 `run_command` 到模型命令的裸 `spawn` 旁路。
- [ ] Shell、Python、Node 及多层子进程只能写工作区和 `/private/tmp`。
- [ ] 用户主目录默认不可读，工作区重新开放，`.ssh`、`.aws`、`.env` 和 Agent 配置保持拒绝。
- [ ] 子进程网络、Apple Events 和任意 Unix Socket 默认关闭。
- [ ] `AGENT_API_KEY`、Token、Password、SSH Agent 和代理凭据不进入子进程环境。
- [ ] `allow / ask / deny` 行为、会话授权、timeout、stdin、输出截断和 Token 统计无回归。
- [ ] 沙箱不可用时 fail closed，不提供自动降级开关。
- [ ] 常规测试、TypeScript 检查和普通 Terminal 中的 `npm run test:sandbox` 全部通过。
