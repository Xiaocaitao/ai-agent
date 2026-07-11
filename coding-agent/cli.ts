import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import { ReActAgent } from "./runtime.ts";
import type { ChatClient } from "./runtime.ts";
import { configureWorkspace } from "./tools/index.ts";
import { loadTools } from "./tools/registry.ts";

// CLI 主函数：组装运行环境、创建 Agent、进入 REPL 循环
export async function runCli(): Promise<void> {
  // 1. 解析并配置工作目录（默认当前目录）
  const workspace = configureWorkspace(process.argv[2] ?? ".");
  // 2. 加载运行时配置（provider / prompt / maxSteps）
  const runtime = await loadRuntime();
  // 3. 加载工具注册表（从 config/tools.json 读取工具列表并动态 import handler）
  const tools = await loadTools();
  // 4. 创建 OpenAI 兼容客户端（支持任意兼容 API 的服务）
  const client = new OpenAI({
    apiKey: runtime.provider.AGENT_API_KEY,
    baseURL: runtime.provider.base_url,
  }) as unknown as ChatClient;
  // 5. 创建 ReAct Agent
  const agent = new ReActAgent(
    client,
    runtime.provider.model,
    runtime.prompt,
    tools,
    runtime.maxSteps,
  );
  console.log(`ReAct Agent 已启动，工作目录: ${workspace}`);
  console.log("输入 exit 或 quit 退出。");
  // 6. 创建 readline 终端交互界面
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
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
  } finally {
    terminal.close();
  }
}
