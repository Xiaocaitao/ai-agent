import path from "node:path";

// 工具策略的最终决策：自动执行、请求用户审批或系统拒绝。
export type PermissionAction = "allow" | "ask" | "deny";
// 用户在 ask 审批界面中的选择；session 只在存在安全资源键时才会生效。
export type ApprovalChoice = "once" | "session" | "reject";

// 权限核心交给 CLI/TUI 的审批请求。canRemember 控制是否展示会话授权选项。
export type ApprovalRequest = {
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
  canRemember: boolean;
  sessionLabel?: string;
};

export type ApprovalPrompt = (
  request: ApprovalRequest,
) => Promise<ApprovalChoice>;

// PermissionEngine 的统一返回值；ToolRegistry 据此决定执行 Handler 或回填拒绝 Observation。
export type PermissionResult = {
  allowed: boolean;
  action: PermissionAction;
  reason?: string;
};

// 能从 argv 第一层确定识别的删除程序。它们永远不能被用户 session 授权覆盖。
const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "del",
  "rd",
  "remove-item",
]);

// Shell 和通用解释器可在参数或脚本中执行任意副作用，因此不生成会话授权键。
const SHELL_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
]);
const INTERPRETER_COMMANDS = new Set([
  "python",
  "python3",
  "node",
  "deno",
  "bun",
]);
// 仅这些 Git 查询子命令可以获得按子命令隔离的 session 授权。
const GIT_SESSION_COMMANDS = new Set(["status", "diff", "log", "show"]);

function commandArguments(value: Record<string, unknown>): string[] {
  return Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === "string")
    : [];
}

function executableName(args: string[]): string {
  return path.basename(args[0] ?? "").toLocaleLowerCase();
}

// 判断是否存在危险参数
function isDangerousArguments(args: string[]): boolean {
  const executable = executableName(args);
  if (DELETE_COMMANDS.has(executable)) return true;
  if (executable !== "git") return false;
  const command = args[1]?.toLocaleLowerCase();
  return (
    command === "clean" ||
    (command === "reset" &&
      args.slice(2).some((item) => item.toLocaleLowerCase() === "--hard"))
  );
}

// 提取常见 Shell 的内联脚本。这里只处理 -c 等确定形式，不尝试完整解析 Shell 语言。
function shellScript(args: string[]): string | undefined {
  const executable = executableName(args);
  if (!SHELL_COMMANDS.has(executable)) return undefined;
  const optionIndex = args.findIndex(
    (item, index) =>
      index > 0 &&
      ["-c", "/c", "-command", "-encodedcommand", "-enc"].includes(
        item.toLocaleLowerCase(),
      ),
  );
  return optionIndex >= 0 ? args[optionIndex + 1] : undefined;
}

// 将明确的命令连接符切开后复用 argv 危险规则；未知语法留给后续 OS 沙箱处理。
function isDangerousShellScript(script: string): boolean {
  return script.split(/&&|\|\||;|\n/).some((part) => {
    const args = part.trim().split(/\s+/).filter(Boolean);
    return isDangerousArguments(args);
  });
}

// run_command 的命令分类结果：dangerous 阻止执行；sessionKey 存在时才允许本会话记忆。
export type CommandPolicy = {
  dangerous: boolean;
  reason?: string;
  sessionKey?: string;
  sessionLabel?: string;
};

// 集中定义命令访问策略，PermissionEngine 和实际 Handler 必须共用，避免一处允许一处拒绝。
export function commandPolicy(args: string[]): CommandPolicy {
  if (isDangerousArguments(args))
    return { dangerous: true, reason: "危险命令被系统策略拒绝" };

  const script = shellScript(args);
  if (script && isDangerousShellScript(script))
    return { dangerous: true, reason: "Shell 脚本包含危险命令" };

  const executable = executableName(args);
  if (SHELL_COMMANDS.has(executable)) return { dangerous: false };
  if (INTERPRETER_COMMANDS.has(executable)) {
    if (executable === "node" && args.length === 2 && args[1] === "--version") {
      return {
        dangerous: false,
        sessionKey: "run_command:node:version",
        sessionLabel: "node --version",
      };
    }
    return { dangerous: false };
  }
  if (
    executable === "git" &&
    GIT_SESSION_COMMANDS.has(args[1]?.toLocaleLowerCase() ?? "")
  ) {
    const command = args[1].toLocaleLowerCase();
    return {
      dangerous: false,
      sessionKey: `run_command:git:${command}`,
      sessionLabel: `git ${command} *`,
    };
  }
  if (
    executable === "npm" &&
    (args[1] === "test" || (args[1] === "run" && args[2] === "test"))
  ) {
    return {
      dangerous: false,
      sessionKey: "run_command:npm:test",
      sessionLabel: "npm test *",
    };
  }
  if (executable === "ls")
    return {
      dangerous: false,
      sessionKey: "run_command:ls",
      sessionLabel: "ls *",
    };
  if (executable === "date")
    return {
      dangerous: false,
      sessionKey: "run_command:date",
      sessionLabel: "date *",
    };
  if (executable === "pwd" && args.length === 1)
    return {
      dangerous: false,
      sessionKey: "run_command:pwd",
      sessionLabel: "pwd",
    };
  return { dangerous: false };
}

// 会话授权的最小匹配单位：写文件精确到路径，命令精确到安全前缀，Shell/解释器没有键。
function resourceKey(
  toolName: string,
  value: Record<string, unknown>,
): string | undefined {
  if (toolName === "write_file")
    return `${toolName}:${path.normalize(String(value.path ?? ""))}`;
  if (toolName === "run_command")
    return commandPolicy(commandArguments(value)).sessionKey;
  if (toolName) {
    return toolName;
  }
  return undefined;
}

function approvalSummary(
  toolName: string,
  value: Record<string, unknown>,
): string {
  if (toolName === "write_file") {
    const content = typeof value.content === "string" ? value.content : "";
    return `写入 ${String(value.path ?? "")}（${Buffer.byteLength(content, "utf8")} 字节）`;
  }
  if (toolName === "run_command")
    return `执行 ${commandArguments(value).join(" ")}`;
  return `执行工具 ${toolName}`;
}

export class PermissionEngine {
  // 仅保存用户明确选择 session 的允许项；拒绝从不写入这里，因此不会形成永久黑名单。
  private readonly sessionGrants = new Set<string>();
  private readonly policies: Record<string, PermissionAction>;
  private readonly approvalPrompt?: ApprovalPrompt;

  constructor(
    policies: Record<string, PermissionAction>,
    approvalPrompt?: ApprovalPrompt,
  ) {
    this.policies = policies;
    this.approvalPrompt = approvalPrompt;
  }

  // Schema 校验后、Handler 执行前的唯一授权入口。
  async authorize(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<PermissionResult> {
    // 命令危险规则优先于配置和已有 session，避免 bash 等入口绕过 deny。
    const command =
      toolName === "run_command"
        ? commandPolicy(commandArguments(argumentsValue))
        : undefined;
    if (command?.dangerous)
      return { allowed: false, action: "deny", reason: command.reason };

    // 缺失策略按 deny 处理，新增工具不能因为漏配而默认放行。
    const action = this.policies[toolName] ?? "deny";
    if (action === "deny")
      return { allowed: false, action, reason: "工具被权限策略拒绝" };
    if (action === "allow") return { allowed: true, action };

    // 只有安全资源键可复用 session；未知命令和解释器仍需每次审批。
    const key = resourceKey(toolName, argumentsValue);
    if (key && this.sessionGrants.has(key))
      return { allowed: true, action: "allow" };
    if (!this.approvalPrompt)
      return {
        allowed: false,
        action: "ask",
        reason: "工具需要审批，但当前没有审批入口",
      };

    try {
      const choice = await this.approvalPrompt({
        toolName,
        arguments: argumentsValue,
        summary: approvalSummary(toolName, argumentsValue),
        canRemember: Boolean(key),
        sessionLabel: command?.sessionLabel,
      });
      // reject 不写入 sessionGrants：它只会由 ToolRegistry 标记为本轮不可绕过。
      if (choice === "reject")
        return { allowed: false, action: "ask", reason: "用户拒绝执行工具" };
      if (choice === "session" && key) this.sessionGrants.add(key);
      return { allowed: true, action: "ask" };
    } catch (error) {
      return {
        allowed: false,
        action: "ask",
        reason: `审批失败: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
}
