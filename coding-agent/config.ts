import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

const BASE_DIR = import.meta.dirname;

export type Provider = {
  AGENT_API_KEY: string;
  base_url: string;
  model: string;
};

export type Runtime = {
  provider: Provider;
  prompt: string;
  maxSteps: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function readToml(filePath: string): Promise<Record<string, unknown>> {
  try {
    return record(parse(await readFile(filePath, "utf8")));
  } catch (error) {
    throw new Error(
      `无法读取配置文件 ${path.basename(filePath)}: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function loadRuntime(root = BASE_DIR): Promise<Runtime> {
  const configDir = path.join(root, "config");
  const config = await readToml(path.join(configDir, "settings.toml"));
  const providerName = String(config.active_provider ?? "");
  const provider = record(record(config.providers)[providerName]);
  if (Object.keys(provider).length === 0)
    throw new Error(`未找到供应商配置: ${providerName}`);
  for (const key of ["AGENT_API_KEY", "base_url", "model"] as const) {
    if (!provider[key])
      throw new Error(`供应商 ${providerName} 缺少配置: ${key}`);
  }

  const agentConfig = record(config.agent);
  const promptName = String(agentConfig.prompt ?? "");
  const prompts = await readToml(path.join(configDir, "prompts.toml"));
  const promptConfig = record(record(prompts.prompts)[promptName]);
  if (!promptConfig.path) throw new Error(`未找到 Prompt 配置: ${promptName}`);
  const promptPath = path.resolve(configDir, String(promptConfig.path));
  const relative = path.relative(configDir, promptPath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Prompt 路径不能超出项目目录");

  let prompt: string;
  try {
    prompt = await readFile(promptPath, "utf8");
  } catch (error) {
    throw new Error(
      `无法读取 Prompt: ${promptPath}: ${error instanceof Error ? error.message : error}`,
    );
  }

  const maxSteps = agentConfig.max_steps ?? 10;
  if (!Number.isInteger(maxSteps) || Number(maxSteps) < 1)
    throw new Error("max_steps 必须是正整数");
  return {
    provider: provider as Provider,
    prompt,
    maxSteps: Number(maxSteps),
  };
}
