import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import { ReActAgent } from "./runtime.ts";
import type { ChatClient, TokenUsage } from "./runtime.ts";
import { configureWorkspace } from "./tools/index.ts";
import { assertMacOsSandboxAvailable } from "./tools/macos_sandbox.ts";
import { loadTools } from "./tools/registry.ts";
import type { ApprovalPrompt, ApprovalRequest } from "./tools/permissions.ts";

type Questioner = {
  question(prompt: string): Promise<string>;
};

// 工作区必须先解析成功；随后沙箱预检失败时直接终止 CLI，禁止降级执行裸命令。
export function prepareCliWorkspace(
  value: string,
  sandboxCheck: () => void = assertMacOsSandboxAvailable,
): string {
  const workspace = configureWorkspace(value);
  sandboxCheck();
  return workspace;
}

export function formatTokenUsage(usage: TokenUsage): string {
  return [
    "本次会话 Token 用量：",
    `输入：${usage.inputTokens}`,
    `输出：${usage.outputTokens}`,
    `总计：${usage.totalTokens}`,
  ].join("\n");
}

export function createApprovalPrompt(
  terminal: Questioner,
  output: (line: string) => void = console.log,
): ApprovalPrompt {
  // CLI 只负责展示和收集选择；是否能记住授权由 PermissionEngine 的安全资源键决定。
  return async (request: ApprovalRequest) => {
    output(`\n权限审批：${request.summary}`);
    output(request.canRemember
      ? `[y] 仅本次允许  [s] 本会话允许${request.sessionLabel ? `（${request.sessionLabel}）` : ""}  [n] 拒绝`
      : "[y] 仅本次允许  [n] 拒绝");
    while (true) {
      const answer = (await terminal.question("选择: ")).trim().toLocaleLowerCase();
      if (answer === "y") return "once";
      if (answer === "s" && request.canRemember) return "session";
      if (answer === "n") return "reject";
      output(request.canRemember ? "请输入 y、s 或 n。" : "请输入 y 或 n。");
    }
  };
}

// CLI 主函数：组装运行环境、创建 Agent、进入 REPL 循环
export async function runCli(): Promise<void> {
  // 1. 解析工作目录并确认 macOS 沙箱可用（默认当前目录）
  const workspace = prepareCliWorkspace(process.argv[2] ?? ".");
  // 2. 加载运行时配置（provider / prompt / maxSteps）
  const runtime = await loadRuntime();
  // 3. 创建 readline，既处理主对话，也处理工具审批
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    // 4. 加载工具，并将终端审批回调注入统一权限系统
    const tools = await loadTools(undefined, createApprovalPrompt(terminal));
    // 5. 创建 OpenAI 兼容客户端（支持任意兼容 API 的服务）
    const client = new OpenAI({
      apiKey: runtime.provider.AGENT_API_KEY,
      baseURL: runtime.provider.base_url,
    }) as unknown as ChatClient;
    // 6. 创建 ReAct Agent
    const agent = new ReActAgent(
      client,
      runtime.provider.model,
      runtime.prompt,
      tools,
      runtime.maxSteps,
    );
    console.log(`ReAct Agent 已启动，工作目录: ${workspace}`);
    console.log("输入 exit 或 quit 退出。");
    // 7. REPL 主循环
    while (true) {
      const userInput = (await terminal.question("You: ")).trim();
      if (["exit", "quit"].includes(userInput.toLocaleLowerCase())) break;
      if (!userInput) continue;
      try {
        // 调用 Agent 处理本轮对话，最多 maxSteps 步
        console.log(`Agent: ${await agent.runTurn(userInput)}`);
      } catch (error) {
        console.log(
          `Agent 错误: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
    console.log(formatTokenUsage(agent.tokenUsage));
  } finally {
    terminal.close();
  }
}
