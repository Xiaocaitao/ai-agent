import { createHash } from "node:crypto";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

import OpenAI from "openai";

import { loadRuntime } from "./config.ts";
import type { FileChange } from "./file_change_tracker.ts";
import { ReActAgent } from "./runtime/agent.ts";
import type { ResponsesClient } from "./runtime/responses.ts";
import type { TokenUsage } from "./runtime/usage.ts";
import { SessionStore } from "./session/store.ts";
import {
  initializeStateDatabase,
  STATE_PRIVACY_NOTICE,
  stateDatabasePath,
} from "./sqlite.ts";
import {
  styleDiff,
  styleRuntimeLine,
  styleText,
  terminalColorsEnabled,
} from "./terminal_style.ts";
import { configureWorkspace } from "./tools/index.ts";
import { assertMacOsSandboxAvailable } from "./tools/macos_sandbox.ts";
import { loadTools } from "./tools/registry.ts";
import type { ApprovalPrompt, ApprovalRequest } from "./tools/permissions.ts";

type Questioner = {
  question(prompt: string): Promise<string>;
};

export function createCliTerminal(
  history: string[],
  input: NodeJS.ReadableStream = stdin,
  output: NodeJS.WritableStream = stdout,
) {
  const terminal = createInterface({
    input,
    output,
    history,
    historySize: 100,
    removeHistoryDuplicates: true,
  });
  let recordedHistory = [...history];
  let shouldRecordAnswer = true;

  terminal.on("history", (currentHistory) => {
    if (shouldRecordAnswer) {
      recordedHistory = [...currentHistory];
      return;
    }
    currentHistory.splice(0, currentHistory.length, ...recordedHistory);
  });

  return {
    question(prompt: string): Promise<string> {
      return terminal.question(prompt);
    },
    async questionWithoutHistory(prompt: string): Promise<string> {
      shouldRecordAnswer = false;
      try {
        return await terminal.question(prompt);
      } finally {
        shouldRecordAnswer = true;
      }
    },
    close(): void {
      terminal.close();
    },
  };
}

export function createApprovalQuestioner(
  terminal: ReturnType<typeof createCliTerminal>,
): Questioner {
  return {
    question(prompt: string): Promise<string> {
      return terminal.questionWithoutHistory(prompt);
    },
  };
}

export type CliArguments = {
  workspace: string;
  resumeSessionId?: string;
  continueLatest: boolean;
};

export function parseCliArguments(values: string[]): CliArguments {
  let index = 0;
  let workspace = ".";
  let resumeSessionId: string | undefined;
  let continueLatest = false;

  if (values[0] !== undefined && !values[0].startsWith("--")) {
    workspace = values[0];
    index = 1;
  }

  while (index < values.length) {
    const value = values[index];
    if (value === "--resume") {
      const candidate = values[index + 1];
      if (candidate === undefined || candidate === "" || candidate.startsWith("--")) {
        throw new Error("--resume 需要 Session ID");
      }
      if (resumeSessionId !== undefined) {
        throw new Error("--resume 不能重复使用");
      }
      resumeSessionId = candidate;
      index += 2;
      continue;
    }
    if (value === "--continue") {
      if (continueLatest) {
        throw new Error("--continue 不能重复使用");
      }
      continueLatest = true;
      index += 1;
      continue;
    }
    throw new Error(`未知参数: ${value}`);
  }

  if (resumeSessionId !== undefined && continueLatest) {
    throw new Error("--resume 与 --continue 不能同时使用");
  }

  return {
    workspace,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    continueLatest,
  };
}

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

export function formatTurnOutput(
  answer: string,
  changes: FileChange[],
  colorsEnabled = false,
): string {
  const sections = [
    styleText(`Agent: ${answer}`, "success", colorsEnabled),
  ];
  for (const change of changes) {
    const lines = [
      styleText(`[Changes] ${change.path}`, "heading", colorsEnabled),
      styleDiff(change.diff.trimEnd(), colorsEnabled),
    ];
    if (change.truncated) {
      lines.push(styleText("[Diff 已截断]", "warning", colorsEnabled));
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
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
  const cliArguments = parseCliArguments(process.argv.slice(2));
  const workspace = prepareCliWorkspace(cliArguments.workspace);
  const colorsEnabled = terminalColorsEnabled(stdout);
  const runtimeOutput = (line: string) => {
    console.log(styleRuntimeLine(line, colorsEnabled));
  };
  const warningOutput = (line: string) => {
    console.log(styleText(line, "warning", colorsEnabled));
  };
  // 2. 加载运行时配置（provider / prompt / maxSteps）
  const runtime = await loadRuntime();
  // 3. 初始化状态数据库；失败时直接终止启动，不降级为无持久化模式
  const stateDatabase = await initializeStateDatabase();
  console.log(`状态数据库: ${stateDatabasePath()}`);
  console.log(STATE_PRIVACY_NOTICE);
  let terminal: ReturnType<typeof createCliTerminal> | undefined;
  try {
    // 4. 先解析 Session，恢复时才能把当前 Session 的提问交给 readline
    const sessionStore = new SessionStore(stateDatabase);
    const systemPromptHash = createHash("sha256")
      .update(runtime.prompt)
      .digest("hex");
    let resumeSessionId = cliArguments.resumeSessionId;
    if (cliArguments.continueLatest) {
      const latestSession = sessionStore.findLatestSession(workspace);
      if (latestSession === undefined) {
        throw new Error("当前工作区没有历史 Session");
      }
      resumeSessionId = latestSession.id;
    }
    const snapshot = resumeSessionId === undefined
      ? undefined
      : sessionStore.loadSnapshot(resumeSessionId, workspace);
    // 5. 同一个 readline 同时处理主对话和工具审批
    terminal = createCliTerminal(snapshot?.questions ?? []);
    // 6. 加载工具，并将终端审批回调注入统一权限系统
    const tools = await loadTools(
      undefined,
      createApprovalPrompt(
        createApprovalQuestioner(terminal),
        warningOutput,
      ),
    );
    // 7. 创建 OpenAI 兼容客户端（支持任意兼容 API 的服务）
    const client = new OpenAI({
      apiKey: runtime.provider.AGENT_API_KEY,
      baseURL: runtime.provider.base_url,
    }) as unknown as ResponsesClient;
    if (
      snapshot !== undefined &&
      snapshot.session.systemPromptHash !== systemPromptHash
    ) {
      console.log("警告：系统提示已变化，将使用当前系统提示继续会话。");
    }
    if (snapshot !== undefined && snapshot.interruptedTurns > 0) {
      console.log("检测到上一轮未完成，已恢复到最后一个完整 Turn。");
    }
    if (snapshot !== undefined) {
      sessionStore.markSessionActive(
        snapshot.session.id,
        runtime.provider.model,
      );
    }
    const session = snapshot?.session ?? sessionStore.createSession(
      workspace,
      runtime.provider.model,
      systemPromptHash,
    );
    // 8. 创建 Agent，并把 Session 持久化记录器注入
    const agent = new ReActAgent(
      client,
      runtime.provider.model,
      runtime.prompt,
      tools,
      runtime.maxSteps,
      snapshot?.items ?? [],
      sessionStore.recorder(session.id),
      runtime.provider.context_window,
    );
    console.log(`Session: ${session.id}`);
    console.log(`ReAct Agent 已启动，工作目录: ${workspace}`);
    console.log("输入 exit 或 quit 退出。");
    // 9. REPL 主循环
    while (true) {
      const userInput = (await terminal.question("You: ")).trim();
      if (["exit", "quit"].includes(userInput.toLocaleLowerCase())) break;
      if (!userInput) continue;
      try {
        // 调用 Agent 处理本轮对话，最多 maxSteps 步
        const answer = await agent.runTurn(userInput, runtimeOutput);
        console.log(formatTurnOutput(
          answer,
          agent.lastTurnFileChanges,
          colorsEnabled,
        ));
      } catch (error) {
        const message = `Agent 错误: ${error instanceof Error ? error.message : error}`;
        console.log(styleText(message, "error", colorsEnabled));
      }
    }
    console.log(formatTokenUsage(agent.tokenUsage));
  } finally {
    terminal?.close();
    stateDatabase.close();
  }
}
