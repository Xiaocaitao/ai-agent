import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadRuntime } from "../config.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-config-test-"));
}

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
