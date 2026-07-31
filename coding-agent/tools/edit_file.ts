import { randomUUID } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { failure, success, workspacePath } from "./_common.ts";
import type { ToolResult } from "./_common.ts";

export async function editFileTool(
  filePath: string,
  oldText: unknown,
  newText: unknown,
): Promise<ToolResult> {
  if (typeof oldText !== "string" || oldText.length === 0)
    return failure("old_text 必须是非空字符串");
  if (typeof newText !== "string") return failure("new_text 必须是字符串");

  let temporaryPath: string | undefined;
  try {
    // 绝对路径，相对路径
    const [target, relativePath] = await workspacePath(filePath);
    const metadata = await lstat(target);
    if (!metadata.isFile()) throw new Error("目标必须是已存在的普通文件");

    const content = await readFile(target, "utf8");
    // 将oldText作为分割符，统计出现了几次
    const matches = content.split(oldText).length - 1;
    if (matches === 0) return failure("未找到 old_text", { matches });
    if (matches > 1)
      return failure("old_text 在文件中出现多次，请提供更多上下文", {
        matches,
      });
    // 确定唯一则将oldText替换为newText
    const updatedContent = content.replace(oldText, newText);
    temporaryPath = path.join(path.dirname(target), `.agent-${randomUUID()}`);
    // wx：w写入文件不存在时创建，x要求文件必须不存在，如果存在则报错
    const file = await open(temporaryPath, "wx", metadata.mode);
    try {
      // 写入新文件
      await file.writeFile(updatedContent, "utf8");
      await file.chmod(metadata.mode);
    } finally {
      await file.close();
    }
    // 原子替换
    await rename(temporaryPath, target);
    temporaryPath = undefined;

    return success({
      path: relativePath,
      replacements: 1,
      bytes_written: Buffer.byteLength(updatedContent, "utf8"),
    });
  } catch (error) {
    return failure(error);
  } finally {
    if (temporaryPath)
      await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export const edit_file = ({
  path,
  old_text,
  new_text,
}: Record<string, unknown>) =>
  editFileTool(String(path ?? ""), old_text, new_text);
