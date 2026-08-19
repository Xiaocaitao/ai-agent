import { readFile } from "node:fs/promises";

import type { SWEbenchWorkerInput } from "./types.ts";

export type SWEbenchTask = {
  instanceId: string;
  repo: string;
  baseCommit: string;
  problemStatement: string;
  failToPass: string[];
  passToPass: string[];
  version?: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("SWE-bench task 必须是 JSON 对象");
  }
  return value as Record<string, unknown>;
}

function firstValue(
  record: Record<string, unknown>,
  names: string[],
): unknown {
  for (const name of names) {
    if (record[name] !== undefined) return record[name];
  }
  return undefined;
}

function requiredString(
  record: Record<string, unknown>,
  names: string[],
  label: string,
): string {
  const value = firstValue(record, names);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} 不能为空`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  names: string[],
): string | undefined {
  const value = firstValue(record, names);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${names[0]} 必须是字符串`);
  return value;
}

function stringArray(
  record: Record<string, unknown>,
  names: string[],
): string[] {
  const value = firstValue(record, names);
  if (value === undefined || value === null || value === "") return [];
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${names[0]} 必须是字符串数组`);
  }
  return parsed.map((item) => item);
}

export function parseSWEbenchTask(text: string): SWEbenchTask {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("SWE-bench task 不是合法 JSON");
  }
  const record = objectValue(value);
  return {
    instanceId: requiredString(record, ["instance_id", "instanceId"], "instance_id"),
    repo: requiredString(record, ["repo"], "repo"),
    baseCommit: requiredString(record, ["base_commit", "baseCommit"], "base_commit"),
    problemStatement: requiredString(
      record,
      ["problem_statement", "problemStatement"],
      "problem_statement",
    ),
    failToPass: stringArray(record, ["FAIL_TO_PASS", "fail_to_pass"]),
    passToPass: stringArray(record, ["PASS_TO_PASS", "pass_to_pass"]),
    version: optionalString(record, ["version"]),
  };
}

export async function loadSWEbenchTasks(filePath: string): Promise<SWEbenchTask[]> {
  const text = await readFile(filePath, "utf8");
  const trimmed = text.trim();
  if (trimmed === "") return [];

  let values: unknown[];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = trimmed.split(/\r?\n/).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error("SWE-bench JSONL 中存在非法 JSON 行");
      }
    });
  }

  const tasks = values.map((value) => parseSWEbenchTask(JSON.stringify(value)));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.instanceId)) {
      throw new Error(`重复的 SWE-bench task: ${task.instanceId}`);
    }
    seen.add(task.instanceId);
  }
  return tasks;
}

/** 只生成 Worker 需要的公开输入；gold patch 和测试集合留在宿主 grader。 */
export function toWorkerInput(task: SWEbenchTask): SWEbenchWorkerInput {
  return {
    taskId: task.instanceId,
    problemStatement: task.problemStatement,
  };
}
