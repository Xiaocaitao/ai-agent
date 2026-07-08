import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import { ReActAgent } from "./runtime.ts";
import type { ChatClient } from "./runtime.ts";
import { configureWorkspace } from "./tools/index.ts";
import { loadTools } from "./tools/registry.ts";

export async function runCli(): Promise<void> {
  const workspace = configureWorkspace(process.argv[2] ?? ".");
  const runtime = await loadRuntime();
  const tools = await loadTools();
  const client = new OpenAI({
    apiKey: runtime.provider.AGENT_API_KEY,
    baseURL: runtime.provider.base_url,
  }) as unknown as ChatClient;
  const agent = new ReActAgent(
    client,
    runtime.provider.model,
    runtime.prompt,
    tools,
    runtime.maxSteps,
  );
  console.log(`ReAct Agent 已启动，工作目录: ${workspace}`);
  console.log("输入 exit 或 quit 退出。");
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const userInput = (await terminal.question("You: ")).trim();
      if (["exit", "quit"].includes(userInput.toLocaleLowerCase())) break;
      if (!userInput) continue;
      try {
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
