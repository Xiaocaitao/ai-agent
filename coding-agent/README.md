# Coding Agent

一个基于 TypeScript 的命令行 Coding Agent。

## 快速开始

1. 安装依赖：`npm install`
2. 复制 `config/settings.example.toml` 为 `config/settings.toml`，并填写模型供应商的 API Key。
3. 启动 Agent：`npm start -- <工作区路径>`；未传入路径时，默认使用当前目录。

## 功能更新日志

### 2026-07-11

- 增加统一的 `allow / ask / deny` 工具审批：读取和搜索默认允许，写文件与命令执行需要用户选择仅本次、本会话允许或拒绝；危险命令会被系统直接拒绝。
- 收紧命令会话授权：仅 `git status/diff/log/show`、`npm test`、`ls`、`date`、`pwd` 等安全前缀可在会话内复用；Shell 和代码解释器只能单次审批，Handler 层也会再次拦截已知危险命令。
- 区分用户拒绝与系统拒绝：用户拒绝仅阻止当前轮绕过，下一条明确用户请求可重新审批；系统 `deny` 在后续轮次仍不可绕过。
- 增加会话级 Token 用量统计：模型响应返回 `usage` 时累计输入、输出和总 Token，输入 `exit` 或 `quit` 后打印本次会话汇总。

### 2026-07-09

- 拆分命令行入口与 Agent 运行时：CLI 负责交互和启动，`runtime.ts` 负责 ReAct 对话循环，方便独立测试和后续扩展。
- 将运行配置独立到 `config.ts`：统一加载供应商、Prompt 和最大执行步数，并在启动阶段校验配置。
- 引入工具注册表：根据 `config/tools.json` 动态加载已启用工具，集中处理工具声明、重复名称和模块加载错误。

### 2026-07-08

- 为工具调用增加 JSON Schema 参数校验：在执行前检查参数类型、必填字段和额外字段，校验失败会返回结构化错误信息。
- 改进模型步骤日志：输出每一步的模型请求、工具调用和观察结果；对较长内容及标准输入/输出进行摘要，便于排查问题且避免日志过长。

### 2026-07-07

- 发布 TypeScript Coding Agent 初版，支持多轮 ReAct 工具调用。
- 内置工作区文件读取、文本搜索、文件写入和非 Shell 命令执行能力。

## 内置工具

| 工具 | 用途 |
| --- | --- |
| `read_file` | 读取工作区内 UTF-8 文本文件的指定行。 |
| `search_files` | 在工作区内递归搜索文本。 |
| `write_file` | 创建或完整覆盖工作区内的 UTF-8 文本文件。 |
| `run_command` | 执行一次非 Shell 命令并返回输出和退出码。 |

## 工具权限

`config/tools.json` 的顶层 `permissions` 为每个启用工具声明权限：

- `allow`：无需确认直接执行。
- `ask`：执行前询问，可选择仅本次允许、本会话允许或拒绝。
- `deny`：始终拒绝执行。

当前默认允许读取和搜索，写文件与运行命令需要审批。会话授权按文件路径或可执行程序保存，进程退出后失效；删除命令、`git clean` 和 `git reset --hard` 始终拒绝，不能被会话授权覆盖。

这套机制是应用层审批，不等同于 OS 沙箱。它不能彻底识别解释器内嵌代码，也不能限制获批子进程的网络访问。

## Token 用量

每次模型请求返回标准 `usage` 时，Agent 会累计输入、输出和总 Token。输入 `exit` 或 `quit` 结束 CLI 会话后，会打印本次进程内的用量汇总；未返回 `usage` 的兼容供应商按 0 统计。

## 配置说明

在 `config/settings.toml` 中设置 `active_provider`，并在对应的 `providers` 配置段填写 `AGENT_API_KEY`、`base_url` 和 `model`。`agent.max_steps` 用于限制单次对话最多执行的模型步骤数，必须是正整数。
