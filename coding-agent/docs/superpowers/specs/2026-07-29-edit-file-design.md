# `edit_file` 唯一文本替换设计

## 目标

新增 `edit_file`，通过唯一的旧文本精确修改已有 UTF-8 文件；同时收紧
`write_file`，使它只能创建新文件，不能覆盖已有文件。

两个工具的职责如下：

- `write_file(path, content)`：只创建新文件，目标已存在时失败。
- `edit_file(path, old_text, new_text)`：只修改已有文件，不创建文件。

## 调用链

```text
模型调用工具
  → ToolRegistry 校验 JSON Schema
  → PermissionEngine 按工具名和文件路径审批
  → workspacePath 校验工作区边界
  → 工具 Handler 执行文件操作
  → 返回结构化结果
```

`edit_file` 的内部流程：

```text
edit_file(path, old_text, new_text)
  → 读取已有文件
  → 查找 old_text
      ├─ 出现 0 次：失败，不修改文件
      ├─ 出现 1 次：生成替换后的完整内容
      └─ 出现多次：失败，不修改文件
  → 将完整新内容写入同目录临时文件
  → 原子替换原文件
  → 返回修改结果
```

## 工具接口

`edit_file` 接收以下参数：

```json
{
  "path": "src/user.ts",
  "old_text": "const enabled = false;",
  "new_text": "const enabled = true;"
}
```

参数规则：

- `path` 必须是非空的工作区相对路径。
- `old_text` 必须是非空字符串，并且在文件中恰好出现一次。
- `new_text` 必须是字符串，可以为空；空字符串表示删除旧文本。
- 匹配使用普通字符串精确匹配，不使用正则表达式。
- `edit_file` 遇到不存在的文件时失败，不创建文件。

唯一性检查需要识别重叠匹配。例如在 `aaa` 中查找 `aa`，应判定为出现
多次并拒绝修改。

成功结果包含规范化后的相对路径、替换次数和新文件字节数：

```json
{
  "ok": true,
  "data": {
    "path": "src/user.ts",
    "replacements": 1,
    "bytes_written": 128
  },
  "error": null
}
```

匹配不到、匹配不唯一、目标不存在或路径越界时，返回失败结果，并保持原文件
内容不变。

## 文件写入策略

新增内部原子写入辅助模块，供两个公开工具复用：

- 先在目标文件的同一目录创建随机临时文件。
- 完整写入并关闭临时文件后，再发布到目标路径。
- `write_file` 使用“目标不存在才创建”的发布方式；目标已存在时失败。
- `edit_file` 使用原子替换方式发布新内容。
- 成功或失败后都清理遗留的临时文件。

这样既能落实两个工具的职责，也能避免程序中断时留下只写了一部分的目标
文件。

## 权限

`write_file` 和 `edit_file` 都使用 `ask` 权限。权限资源精确到规范化后的工具名
和文件路径：

```text
write_file:src/new-file.ts
edit_file:src/user.ts
```

两个工具的会话授权相互独立。允许创建某个路径，不自动允许编辑该路径。

## 改动范围

- `tools/_atomic_write.ts`：新增内部原子写入辅助函数。
- `tools/write_file.ts`：改为只创建新文件。
- `tools/edit_file.ts`：新增唯一旧文本替换实现。
- `tools/index.ts`：导出 `edit_file`。
- `config/tools.json`：注册工具 Schema 和 `ask` 权限。
- `tools/permissions.ts`：增加 `edit_file` 的路径级审批。
- `tests/tools.test.ts`：覆盖创建、替换和失败时不修改文件。
- `tests/tools/registry.test.ts`：验证注册表包含 `edit_file`。
- `tests/tools/permissions.test.ts`：验证路径级审批。
- `README.md` 和 Agent Prompt：说明创建与编辑应使用不同工具。

不修改 `run_command`、运行时循环、数据库、会话持久化或 macOS Seatbelt。

## 测试

至少覆盖以下行为：

1. `write_file` 能创建新文件。
2. `write_file` 拒绝覆盖，并保留原内容。
3. `edit_file` 能替换唯一旧文本。
4. 空 `new_text` 能删除旧文本。
5. 文件不存在时失败。
6. `old_text` 找不到时失败。
7. `old_text` 普通重复或重叠重复时失败。
8. 所有失败场景都保持原文件内容不变。
9. 工作区越界和符号链接逃逸仍然被拒绝。
10. 注册表和权限配置包含 `edit_file`。

验证命令：

```bash
npm test
npm run typecheck
git diff --check
```

## 分步开发顺序

每一步完成后停止，等待 Review：

1. 先增加失败测试，固定 `write_file` 和 `edit_file` 的外部语义。
2. 实现原子写入辅助函数，并让 `write_file` 只创建新文件。
3. 实现 `edit_file` 的唯一文本替换。
4. 接入工具注册表和权限审批。
5. 更新文档并运行完整验证。

