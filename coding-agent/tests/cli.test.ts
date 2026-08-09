import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import * as cliModule from "../cli.ts";
import {
  createApprovalPrompt,
  formatTokenUsage,
  parseCliArguments,
  prepareCliWorkspace,
} from "../cli.ts";

const run = promisify(execFile);
const macOsOnly = { skip: process.platform !== "darwin" };

function runCliWithInput(
  entry: string,
  workspace: string,
  home: string,
  input: string,
  extraArguments: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", entry, workspace, ...extraArguments],
      {
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let childStdout = "";
    let childStderr = "";
    let inputSent = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (value: string) => {
      childStdout += value;
      if (!inputSent && childStdout.includes("You: ")) {
        inputSent = true;
        child.stdin.write(input);
      }
    });
    child.stderr.on("data", (value: string) => {
      childStderr += value;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout: childStdout, stderr: childStderr });
    });
  });
}

async function removeCliSessionFixture(
  databasePath: string,
  home: string,
  workspace: string,
): Promise<void> {
  await unlink(`${databasePath}-shm`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(`${databasePath}-wal`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await unlink(databasePath);
  await rmdir(path.dirname(databasePath));
  await rmdir(home);
  await rmdir(workspace);
}

test("CLI 解析新建、指定恢复和继续最近会话参数", () => {
  assert.deepEqual(parseCliArguments([]), {
    workspace: ".",
    continueLatest: false,
  });
  assert.deepEqual(parseCliArguments(["/workspace", "--resume", "session-1"]), {
    workspace: "/workspace",
    resumeSessionId: "session-1",
    continueLatest: false,
  });
  assert.deepEqual(parseCliArguments(["/workspace", "--continue"]), {
    workspace: "/workspace",
    continueLatest: true,
  });
});

test("CLI 拒绝无效或冲突的 Session 参数", () => {
  assert.throws(
    () => parseCliArguments(["/workspace", "--resume"]),
    /--resume 需要 Session ID/,
  );
  assert.throws(
    () =>
      parseCliArguments([
        "/workspace",
        "--resume",
        "session-1",
        "--continue",
      ]),
    /--resume 与 --continue 不能同时使用/,
  );
  assert.throws(
    () => parseCliArguments(["/workspace", "--unknown"]),
    /未知参数: --unknown/,
  );
});

test("CLI 工作区有效时必须执行沙箱预检", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-cli-test-"));
  let checked = false;

  assert.equal(
    prepareCliWorkspace(root, () => {
      checked = true;
    }),
    realpathSync(root),
  );
  assert.equal(checked, true);
});

test("CLI 工作区无效时不继续执行沙箱预检", () => {
  let checked = false;
  assert.throws(
    () =>
      prepareCliWorkspace("/missing/coding-agent-workspace", () => {
        checked = true;
      }),
    /工作目录不存在或不是目录/,
  );
  assert.equal(checked, false);
});

test("CLI 在工作目录无效时以配置错误退出", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-cli-test-"));
  const missing = path.join(root, "missing");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  await assert.rejects(
    () => run(process.execPath, ["--experimental-strip-types", entry, missing]),
    (error: unknown) => {
      const result = error as { code: number; stderr: string };
      assert.equal(result.code, 1);
      assert.match(result.stderr, /配置错误: 工作目录不存在或不是目录/);
      return true;
    },
  );
});

test("CLI 启动时创建并显示新的 Session", macOsOnly, async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "coding-agent-workspace-test-"),
  );
  const home = await mkdtemp(path.join(tmpdir(), "coding-agent-home-test-"));
  const databasePath = path.join(home, ".coding-agent", "state.sqlite");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  try {
    const result = await runCliWithInput(entry, workspace, home, "exit\n");

    assert.equal(result.code, 0, result.stderr);
    const sessionMatch = result.stdout.match(/Session: ([^\s]+)/);
    assert.ok(sessionMatch, result.stdout);

    const database = new DatabaseSync(databasePath);
    try {
      const session = database.prepare(`
        SELECT id, workspace_path, last_model, system_prompt_hash
        FROM sessions
      `).get() as Record<string, unknown>;
      assert.equal(session.id, sessionMatch[1]);
      assert.equal(session.workspace_path, realpathSync(workspace));
      assert.equal(typeof session.last_model, "string");
      assert.match(String(session.system_prompt_hash), /^[0-9a-f]{64}$/);
    } finally {
      database.close();
    }
  } finally {
    await removeCliSessionFixture(databasePath, home, workspace);
  }
});

test("CLI 按 ID 恢复原 Session 而不创建新 Session", macOsOnly, async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "coding-agent-resume-workspace-test-"),
  );
  const home = await mkdtemp(
    path.join(tmpdir(), "coding-agent-resume-home-test-"),
  );
  const databasePath = path.join(home, ".coding-agent", "state.sqlite");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  try {
    const created = await runCliWithInput(entry, workspace, home, "exit\n");
    assert.equal(created.code, 0, created.stderr);
    const createdSession = created.stdout.match(/Session: ([^\s]+)/)?.[1];
    assert.ok(createdSession, created.stdout);

    const resumed = await runCliWithInput(
      entry,
      workspace,
      home,
      "exit\n",
      ["--resume", createdSession],
    );
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, new RegExp(`Session: ${createdSession}`));

    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM sessions")
        .get() as Record<string, unknown>;
      assert.equal(row.count, 1);
    } finally {
      database.close();
    }
  } finally {
    await removeCliSessionFixture(databasePath, home, workspace);
  }
});

test("CLI 继续当前工作区最近的 Session", macOsOnly, async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "coding-agent-continue-workspace-test-"),
  );
  const home = await mkdtemp(
    path.join(tmpdir(), "coding-agent-continue-home-test-"),
  );
  const databasePath = path.join(home, ".coding-agent", "state.sqlite");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  try {
    const first = await runCliWithInput(entry, workspace, home, "exit\n");
    assert.equal(first.code, 0, first.stderr);

    const second = await runCliWithInput(entry, workspace, home, "exit\n");
    assert.equal(second.code, 0, second.stderr);
    const latestSession = second.stdout.match(/Session: ([^\s]+)/)?.[1];
    assert.ok(latestSession, second.stdout);

    const continued = await runCliWithInput(
      entry,
      workspace,
      home,
      "exit\n",
      ["--continue"],
    );
    assert.equal(continued.code, 0, continued.stderr);
    assert.match(continued.stdout, new RegExp(`Session: ${latestSession}`));

    const database = new DatabaseSync(databasePath);
    try {
      const row = database
        .prepare("SELECT COUNT(*) AS count FROM sessions")
        .get() as Record<string, unknown>;
      assert.equal(row.count, 2);
    } finally {
      database.close();
    }
  } finally {
    await removeCliSessionFixture(databasePath, home, workspace);
  }
});

test("CLI 恢复时提示系统规则变化和未完成 Turn", macOsOnly, async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "coding-agent-warning-workspace-test-"),
  );
  const home = await mkdtemp(
    path.join(tmpdir(), "coding-agent-warning-home-test-"),
  );
  const databasePath = path.join(home, ".coding-agent", "state.sqlite");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  try {
    const created = await runCliWithInput(entry, workspace, home, "exit\n");
    assert.equal(created.code, 0, created.stderr);
    const sessionId = created.stdout.match(/Session: ([^\s]+)/)?.[1];
    assert.ok(sessionId, created.stdout);

    const database = new DatabaseSync(databasePath);
    try {
      database
        .prepare("UPDATE sessions SET system_prompt_hash = ? WHERE id = ?")
        .run("old-system-prompt-hash", sessionId);
      database.prepare(`
        INSERT INTO turns
          (id, session_id, sequence, user_input, status, started_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `).run("interrupted-turn", sessionId, 1, "unfinished question", 1);
    } finally {
      database.close();
    }

    const resumed = await runCliWithInput(
      entry,
      workspace,
      home,
      "exit\n",
      ["--resume", sessionId],
    );
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /系统提示已变化/);
    assert.match(resumed.stdout, /上一轮未完成/);

    const reopened = new DatabaseSync(databasePath);
    try {
      const turn = reopened
        .prepare("SELECT status FROM turns WHERE id = ?")
        .get("interrupted-turn") as Record<string, unknown>;
      assert.equal(turn.status, "interrupted");
    } finally {
      reopened.close();
    }
  } finally {
    await removeCliSessionFixture(databasePath, home, workspace);
  }
});

test("CLI 恢复时更新 Session 的当前模型和活跃时间", macOsOnly, async () => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "coding-agent-model-workspace-test-"),
  );
  const home = await mkdtemp(
    path.join(tmpdir(), "coding-agent-model-home-test-"),
  );
  const databasePath = path.join(home, ".coding-agent", "state.sqlite");
  const entry = path.resolve(import.meta.dirname, "../agent.ts");

  try {
    const created = await runCliWithInput(entry, workspace, home, "exit\n");
    assert.equal(created.code, 0, created.stderr);
    const sessionId = created.stdout.match(/Session: ([^\s]+)/)?.[1];
    assert.ok(sessionId, created.stdout);

    const database = new DatabaseSync(databasePath);
    let currentModel: string;
    try {
      const session = database
        .prepare("SELECT last_model FROM sessions WHERE id = ?")
        .get(sessionId) as Record<string, unknown>;
      currentModel = String(session.last_model);
      database
        .prepare(`
          UPDATE sessions
          SET last_model = ?, updated_at = ?
          WHERE id = ?
        `)
        .run("legacy-model", 1, sessionId);
    } finally {
      database.close();
    }

    const resumed = await runCliWithInput(
      entry,
      workspace,
      home,
      "exit\n",
      ["--resume", sessionId],
    );
    assert.equal(resumed.code, 0, resumed.stderr);

    const reopened = new DatabaseSync(databasePath);
    try {
      const session = reopened
        .prepare(`
          SELECT last_model, updated_at
          FROM sessions
          WHERE id = ?
        `)
        .get(sessionId) as Record<string, unknown>;
      assert.equal(session.last_model, currentModel);
      assert.ok(Number(session.updated_at) > 1);
    } finally {
      reopened.close();
    }
  } finally {
    await removeCliSessionFixture(databasePath, home, workspace);
  }
});

test("CLI 审批输入映射为 once、session 和 reject", async () => {
  const answers = ["x", "y", "s", "n"];
  const lines: string[] = [];
  const prompt = createApprovalPrompt(
    { question: async () => answers.shift() ?? "n" },
    lines.push.bind(lines),
  );
  const request = {
    toolName: "write_file",
    arguments: {},
    summary: "写入 a.ts",
    canRemember: true,
  };

  assert.equal(await prompt(request), "once");
  assert.equal(await prompt(request), "session");
  assert.equal(await prompt(request), "reject");
  assert.ok(lines.some((line) => line.includes("请输入 y、s 或 n")));
});

test("CLI 对不能会话授权的请求不展示 session 选项", async () => {
  const lines: string[] = [];
  const prompt = createApprovalPrompt(
    { question: async () => "y" },
    lines.push.bind(lines),
  );

  assert.equal(
    await prompt({
      toolName: "run_command",
      arguments: {},
      summary: "执行 bash -c echo ok",
      canRemember: false,
    }),
    "once",
  );
  assert.ok(lines.some((line) => line.includes("[y] 仅本次允许  [n] 拒绝")));
  assert.equal(lines.some((line) => line.includes("[s]")), false);
});

test("CLI 终端按上方向键返回当前 Session 的最新提问", async () => {
  const createCliTerminal = (
    cliModule as typeof cliModule & {
      createCliTerminal?: (
        history: string[],
        input: PassThrough,
        output: PassThrough,
      ) => {
        question(prompt: string): Promise<string>;
        close(): void;
      };
    }
  ).createCliTerminal;
  assert.ok(createCliTerminal, "CLI 尚未提供带 Session 历史的终端");

  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(output, { isTTY: true });
  const terminal = createCliTerminal(
    ["最近的提问", "更早的提问"],
    input,
    output,
  );
  try {
    const answer = terminal.question("You: ");
    input.write("\u001b[A\n");

    assert.equal(await answer, "最近的提问");
  } finally {
    terminal.close();
  }
});

test("CLI 权限审批答案不进入提问历史", async () => {
  const createApprovalQuestioner = (
    cliModule as typeof cliModule & {
      createApprovalQuestioner?: (
        terminal: ReturnType<typeof cliModule.createCliTerminal>,
      ) => {
        question(prompt: string): Promise<string>;
      };
    }
  ).createApprovalQuestioner;
  assert.ok(createApprovalQuestioner, "CLI 尚未隔离权限审批历史");

  const input = new PassThrough();
  const output = new PassThrough();
  Object.assign(output, { isTTY: true });
  const terminal = cliModule.createCliTerminal(
    ["原来的提问"],
    input,
    output,
  );
  try {
    const approvalPrompt = createApprovalPrompt(
      createApprovalQuestioner(terminal),
      () => {},
    );
    const approval = approvalPrompt({
      toolName: "write_file",
      arguments: {},
      summary: "写入 a.ts",
      canRemember: true,
    });
    input.write("y\n");
    assert.equal(await approval, "once");

    const nextQuestion = terminal.question("You: ");
    input.write("\u001b[A\n");
    assert.equal(await nextQuestion, "原来的提问");
  } finally {
    terminal.close();
  }
});

test("CLI 格式化退出时的 Token 汇总", () => {
  assert.equal(
    formatTokenUsage({ inputTokens: 1234, outputTokens: 567, totalTokens: 1801 }),
    "本次会话 Token 用量：\n输入：1234\n输出：567\n总计：1801",
  );
});

test("CLI 按流事件顺序显示 Thinking 和 Agent", () => {
  const createCliStreamRenderer = (cliModule as Record<string, unknown>)
    .createCliStreamRenderer;
  assert.equal(typeof createCliStreamRenderer, "function");
  if (typeof createCliStreamRenderer !== "function") return;

  const chunks: string[] = [];
  const renderer = createCliStreamRenderer(
    (text: string) => chunks.push(text),
    false,
  ) as {
    writeDelta(delta: { kind: "reasoning" | "answer"; text: string }): void;
    finishLine(): void;
    readonly answerWritten: boolean;
  };

  renderer.writeDelta({ kind: "reasoning", text: "先" });
  renderer.writeDelta({ kind: "reasoning", text: "分析" });
  renderer.writeDelta({ kind: "answer", text: "完成" });
  renderer.finishLine();

  assert.equal(chunks.join(""), "Thinking: 先分析\nAgent: 完成\n");
  assert.equal(renderer.answerWritten, true);
});

test("CLI 流式回答完成后只格式化文件 Diff", () => {
  const formatFileChanges = (cliModule as Record<string, unknown>)
    .formatFileChanges;
  assert.equal(typeof formatFileChanges, "function");
  if (typeof formatFileChanges !== "function") return;

  assert.equal(
    formatFileChanges([{
      path: "example.ts",
      diff: "--- a/example.ts\n+++ b/example.ts\n-old\n+new\n",
      truncated: false,
    }]),
    [
      "[Changes] example.ts",
      "--- a/example.ts\n+++ b/example.ts\n-old\n+new",
    ].join("\n"),
  );
});

test("CLI 在最终回答后展示整轮文件 Diff", () => {
  const formatTurnOutput = (cliModule as Record<string, unknown>)
    .formatTurnOutput;
  assert.equal(typeof formatTurnOutput, "function");
  if (typeof formatTurnOutput !== "function") return;

  assert.equal(
    formatTurnOutput("finished", [{
      path: "example.ts",
      diff: "--- a/example.ts\n+++ b/example.ts\n-old\n+new\n",
      truncated: true,
    }]),
    [
      "Agent: finished",
      "",
      "[Changes] example.ts",
      "--- a/example.ts\n+++ b/example.ts\n-old\n+new",
      "[Diff 已截断]",
    ].join("\n"),
  );
});

test("CLI 为最终回答和 Diff 添加终端颜色且保留原文", () => {
  const formatTurnOutput = (cliModule as Record<string, unknown>)
    .formatTurnOutput;
  assert.equal(typeof formatTurnOutput, "function");
  if (typeof formatTurnOutput !== "function") return;

  const colored = String(formatTurnOutput("finished", [{
    path: "example.ts",
    diff: "@@ -1,1 +1,1 @@\n-old\n+new\n",
    truncated: false,
  }], true));

  assert.match(colored, /\x1b\[38;2;/);
  assert.equal(
    colored.replaceAll(/\x1b\[[0-9;]+m/g, ""),
    [
      "Agent: finished",
      "",
      "[Changes] example.ts",
      "@@ -1,1 +1,1 @@\n-old\n+new",
    ].join("\n"),
  );
});
