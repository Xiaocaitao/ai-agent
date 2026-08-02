import { readFile } from "node:fs/promises";

import { createTwoFilesPatch } from "diff";

import { truncate, workspacePath } from "./tools/_common.ts";

// 文件快照 修改前
type FileSnapshot = {
  exists: boolean;
  content: string;
};

// 记录一次文件变更，被修改
export type FileChangeCapture = {
  path: string;
  target: string;
  before: FileSnapshot; // 修改前的文件快照片
};

// 文件修改后的变更效果，最终diff
export type FileChange = {
  path: string;
  diff: string; // 内容差异
  truncated: boolean; // 是否被截断
};

function isMissingFile(error: unknown): boolean {
  return (
    // 抓文件不存在的错误码
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function snapshot(target: string): Promise<FileSnapshot> {
  try {
    return { exists: true, content: await readFile(target, "utf8") };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false, content: "" };
    throw error;
  }
}

function fileChange(
  path: string,
  before: FileSnapshot,
  after: FileSnapshot,
): FileChange | undefined {
  // 文件和内容都无变化
  if (before.exists === after.exists && before.content === after.content) {
    return undefined;
  }
  // 生成diff
  const patch = createTwoFilesPatch(
    `a/${path}`,
    `b/${path}`,
    before.content,
    after.content,
    undefined,
    undefined,
    { context: 3 },// 保留前后三行上下文
  );
  // 过长则截断
  const [diff, truncated] = truncate(patch);
  return { path, diff, truncated };
}

export class FileChangeTracker {
  // 起始文件状态 key唯一文件路径，value起始状态
  private readonly initialSnapshots = new Map<string, FileSnapshot>();
  // 结束文件状态 key唯一文件路径，value最终状态
  private readonly finalSnapshots = new Map<string, FileSnapshot>();

  beginTurn(): void {
    this.initialSnapshots.clear();
    this.finalSnapshots.clear();
  }

  // 保留第一次修改前的快照
  async captureBefore(filePath: string): Promise<FileChangeCapture> {
    const [target, relativePath] = await workspacePath(filePath);
    const before = await snapshot(target);
    if (!this.initialSnapshots.has(relativePath)) {
      this.initialSnapshots.set(relativePath, before);
    }
    return { path: relativePath, target, before };
  }

  // 一次工具调用的diff
  async captureAfter(
    capture: FileChangeCapture,
  ): Promise<FileChange | undefined> {
    const after = await snapshot(capture.target);
    // 保留某个文件的一次修改
    this.finalSnapshots.set(capture.path, after);
    // 产生本次修改的diff
    return fileChange(capture.path, capture.before, after);
  }

  // 本轮的diff
  finishTurn(): FileChange[] {
    const changes: FileChange[] = [];
    // 每个文件进行diff
    for (const [path, before] of this.initialSnapshots) {
      // 找path的最终修改
      const after = this.finalSnapshots.get(path);
      if (after === undefined) continue;
      // 进行diff
      const change = fileChange(path, before, after);
      // 保留diff的文件
      if (change !== undefined) changes.push(change);
    }
    return changes;
  }
}
