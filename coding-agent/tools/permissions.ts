import path from "node:path";

export type PermissionAction = "allow" | "ask" | "deny";
export type ApprovalChoice = "once" | "session" | "reject";

export type ApprovalRequest = {
  toolName: string;
  arguments: Record<string, unknown>;
  summary: string;
};

export type ApprovalPrompt = (
  request: ApprovalRequest,
) => Promise<ApprovalChoice>;

export type PermissionResult = {
  allowed: boolean;
  action: PermissionAction;
  reason?: string;
};

const DELETE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "unlink",
  "del",
  "rd",
  "remove-item",
]);

function commandArguments(value: Record<string, unknown>): string[] {
  return Array.isArray(value.args)
    ? value.args.filter((item): item is string => typeof item === "string")
    : [];
}

function isDangerousCommand(value: Record<string, unknown>): boolean {
  const args = commandArguments(value);
  const executable = path.basename(args[0] ?? "").toLocaleLowerCase();
  if (DELETE_COMMANDS.has(executable)) return true;
  if (executable !== "git") return false;
  const command = args[1]?.toLocaleLowerCase();
  return command === "clean" || (
    command === "reset" && args.slice(2).some((item) => item.toLocaleLowerCase() === "--hard")
  );
}

function resourceKey(toolName: string, value: Record<string, unknown>): string {
  if (toolName === "write_file")
    return `${toolName}:${path.normalize(String(value.path ?? ""))}`;
  if (toolName === "run_command") {
    const executable = path.basename(commandArguments(value)[0] ?? "").toLocaleLowerCase();
    return `${toolName}:${executable}`;
  }
  return toolName;
}

function approvalSummary(toolName: string, value: Record<string, unknown>): string {
  if (toolName === "write_file") {
    const content = typeof value.content === "string" ? value.content : "";
    return `写入 ${String(value.path ?? "")}（${Buffer.byteLength(content, "utf8")} 字节）`;
  }
  if (toolName === "run_command")
    return `执行 ${commandArguments(value).join(" ")}`;
  return `执行工具 ${toolName}`;
}

export class PermissionEngine {
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

  async authorize(
    toolName: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<PermissionResult> {
    if (toolName === "run_command" && isDangerousCommand(argumentsValue))
      return { allowed: false, action: "deny", reason: "危险命令被系统策略拒绝" };

    const action = this.policies[toolName] ?? "deny";
    if (action === "deny")
      return { allowed: false, action, reason: "工具被权限策略拒绝" };
    if (action === "allow") return { allowed: true, action };

    const key = resourceKey(toolName, argumentsValue);
    if (this.sessionGrants.has(key)) return { allowed: true, action: "allow" };
    if (!this.approvalPrompt)
      return { allowed: false, action: "ask", reason: "工具需要审批，但当前没有审批入口" };

    try {
      const choice = await this.approvalPrompt({
        toolName,
        arguments: argumentsValue,
        summary: approvalSummary(toolName, argumentsValue),
      });
      if (choice === "reject")
        return { allowed: false, action: "ask", reason: "用户拒绝执行工具" };
      if (choice === "session") this.sessionGrants.add(key);
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
