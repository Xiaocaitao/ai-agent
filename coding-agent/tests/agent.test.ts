import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntime, loadTools, ReActAgent, resolveWorkspace, sanitizeUnicode } from "../agent.ts";
import type { ToolHandler } from "../agent.ts";

function message(content: string | null = null, toolCalls: ReturnType<typeof toolCall>[] = []) {
  return { content, tool_calls: toolCalls };
}

function toolCall(name = "echo", argumentsValue = '{"text":"hello"}', id = "call-1") {
  return { id, type: "function" as const, function: { name, arguments: argumentsValue } };
}

const echoSpecs = [{
  type: "function" as const,
  function: { name: "echo", parameters: { type: "object" } },
}];

function fakeClient(...messages: ReturnType<typeof message>[]) {
  const calls: unknown[] = [];
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (request: unknown) => {
            calls.push(request);
            return { choices: [{ message: messages.shift()! }] };
          },
        },
      },
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-agent-test-"));
}

test("resolveWorkspace 接受目录并拒绝文件", async () => {
  const root = await temporaryDirectory();
  const file = path.join(root, "file.txt");
  await writeFile(file, "content");
  assert.equal(await resolveWorkspace(root), root);
  await assert.rejects(() => resolveWorkspace(file), /工作目录/);
});

test("loadRuntime 加载供应商、Prompt 和最大步骤", async () => {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, "config/prompts"), { recursive: true });
  await writeFile(path.join(root, "config/settings.toml"), 'active_provider = "deepseek"\n[agent]\nprompt = "react"\nmax_steps = 3\n[providers.deepseek]\nAGENT_API_KEY = "secret"\nbase_url = "https://example.test"\nmodel = "model-x"\n');
  await writeFile(path.join(root, "config/prompts.toml"), '[prompts.react]\npath = "prompts/react.md"\n');
  await writeFile(path.join(root, "config/prompts/react.md"), "react prompt");
  const runtime = await loadRuntime(root);
  assert.equal(runtime.provider.model, "model-x");
  assert.equal(runtime.prompt, "react prompt");
  assert.equal(runtime.maxSteps, 3);
});

test("loadRuntime 拒绝缺失供应商字段", async () => {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, "config"));
  await writeFile(path.join(root, "config/settings.toml"), 'active_provider = "openai"\n[agent]\nprompt = "react"\n[providers.openai]\nAGENT_API_KEY = ""\nbase_url = ""\nmodel = ""\n');
  await writeFile(path.join(root, "config/prompts.toml"), '[prompts.react]\npath = "missing.md"\n');
  await assert.rejects(() => loadRuntime(root), /AGENT_API_KEY/);
});

test("loadTools 加载项目工具并支持空注册表", async () => {
  const empty = await temporaryDirectory();
  await mkdir(path.join(empty, "config"));
  await writeFile(path.join(empty, "config/tools.json"), '{"tools": []}\n');
  assert.deepEqual(await loadTools(empty), { specs: [], handlers: {} });

  const loaded = await loadTools();
  assert.deepEqual(Object.keys(loaded.handlers).sort(), ["read_file", "run_command", "search_files", "write_file"]);
  assert.deepEqual(loaded.specs.map((spec) => spec.function.name).sort(), Object.keys(loaded.handlers).sort());
});

test("sanitizeUnicode 清洗嵌套的孤立代理项", () => {
  assert.deepEqual(sanitizeUnicode({ emoji: "\ud83d\ude0a", broken: ["\ud83d", "中文✅"] }), { emoji: "😊", broken: ["�", "中文✅"] });
});

test("ReActAgent 无工具调用时返回最终回答", async () => {
  const { client, calls } = fakeClient(message("done"));
  const agent = new ReActAgent(client, "model-x", "prompt", [], {}, 3);
  assert.equal(await agent.runTurn("hello", () => undefined), "done");
  assert.equal("tools" in (calls[0] as object), false);
  assert.equal(agent.messages.at(-1)?.content, "done");
});

test("ReActAgent 执行工具并记录 Observation", async () => {
  const { client } = fakeClient(message(null, [toolCall()]), message("finished"));
  const output: string[] = [];
  const agent = new ReActAgent(client, "model-x", "prompt", echoSpecs, { echo: ({ text }) => ({ ok: true, data: { text }, error: null }) }, 3);
  assert.equal(await agent.runTurn("say hello", output.push.bind(output)), "finished");
  assert.deepEqual(agent.messages.map(({ role }) => role), ["system", "user", "assistant", "tool", "assistant"]);
  assert.deepEqual(JSON.parse(String(agent.messages[3]?.content)), { ok: true, data: { text: "hello" }, error: null });
  assert.ok(output.some((line) => line.includes("Action:")));
  assert.ok(output.some((line) => line.includes("Observation:")));
});

test("ReActAgent 将工具错误转为 Observation", async () => {
  const cases: Array<{ call: ReturnType<typeof toolCall>; handlers: Record<string, ToolHandler>; expected: string }> = [
    { call: toolCall("missing"), handlers: {}, expected: "未注册工具" },
    { call: toolCall("echo", "{"), handlers: { echo: () => "ok" }, expected: "参数不是合法 JSON" },
    { call: toolCall(), handlers: { echo: () => { throw new Error("boom"); } }, expected: "工具执行失败" },
  ];
  for (const item of cases) {
    const { client } = fakeClient(message(null, [item.call]), message("recovered"));
    const specs = Object.hasOwn(item.handlers, "echo") ? echoSpecs : [];
    const agent = new ReActAgent(client, "model-x", "prompt", specs, item.handlers, 3);
    assert.equal(await agent.runTurn("run", () => undefined), "recovered");
    assert.match(String(agent.messages[3]?.content), new RegExp(item.expected));
  }
});

test("ReActAgent 达到最大步骤时停止", async () => {
  const { client } = fakeClient(message(null, [toolCall()]));
  const agent = new ReActAgent(client, "model-x", "prompt", echoSpecs, { echo: ({ text }) => text }, 1);
  await assert.rejects(() => agent.runTurn("loop", () => undefined), /最大步骤/);
});
