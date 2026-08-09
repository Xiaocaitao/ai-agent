# Coding Agent

一个基于 TypeScript 的命令行 Coding Agent。

## 快速开始

1. 安装依赖：`npm install`
2. 复制 `config/settings.example.toml` 为 `config/settings.toml`，并填写模型供应商的 API Key。
3. 启动 Agent：`npm start -- <工作区路径>`；未传入路径时，默认使用当前目录。

## 功能更新日志

### 2026-08-09

- 模型请求迁移到 Responses API，使用原生 message、reasoning、function_call 和 function_call_output items 传递与持久化上下文。
- Runtime 按 Agent 主流程、Responses 转换、Token 用量、日志、压缩和 Session 接口拆分为独立模块。
- 修复 macOS Seatbelt 误拦截用户主目录内 workspace 路径解析的问题，Node 子进程可读取工作区文件，仍拒绝工作区外和敏感路径。

### 2026-08-01

- 增加自动上下文压缩：根据供应商的 `context_window` 和响应 `usage` 监测占用率，达到 80% 时警告并触发 Compact。
- Compact 由 Runtime 在 ReAct 运行中或 Turn 完成后执行，使用当前模型摘要旧消息，同时保留最近两个完整 Turn 和当前 Turn。
- 压缩摘要持久化到 Session；恢复会话时加载最新摘要与压缩边界之后的消息，压缩失败时保留原上下文继续运行。
- 增加 `edit_file`：通过唯一的 `old_text` 精确替换现有文件内容；零匹配或多匹配时拒绝修改。
- 修改采用临时文件原子替换并保留原文件权限；不存在的文件和符号链接会被拒绝。
- `edit_file` 默认需要审批，本会话授权仅对同一文件路径生效。

### 2026-07-29

- 增加基于 SQLite 的 Session 持久化，按顺序记录 Turn、用户消息、模型回复和工具结果，进程退出后仍可恢复。
- 支持 `--resume <session-id>` 恢复指定会话，以及 `--continue` 继续当前工作区最近的会话；恢复时只加载完整 Turn。
- 当前 Session 的历史提问会恢复到终端，按上方向键可以继续查找之前的问题；权限审批输入不会进入提问历史。

### 2026-07-12

- `run_command` 接入 macOS Seatbelt：所有获批命令统一通过 `/usr/bin/sandbox-exec` 启动，限制自动继承到 Shell、Python、Node 等后代进程。
- 默认只允许写当前工作区和 `/private/tmp`，拒绝用户主目录、`.ssh`、`.aws`、`.env` 和 Agent 可信配置等敏感读取，并默认关闭子进程网络、Apple Events 和任意 Unix Socket。
- 子进程环境改为最小白名单，不再传入 API Key、Token、Password、SSH Agent 和代理凭据；沙箱或 Profile 不可用时 CLI 直接终止，不降级执行裸命令。
- 增加 `npm run test:sandbox`，从普通 macOS Terminal 验证工作区内写入、工作区外读写拒绝、多层子进程网络拒绝和敏感环境变量清理。

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
| `edit_file` | 将现有 UTF-8 文本文件中唯一的 `old_text` 替换为 `new_text`。 |
| `write_file` | 创建或完整覆盖工作区内的 UTF-8 文本文件。 |
| `run_command` | 执行一次非 Shell 命令并返回输出和退出码。 |

## 工具权限

`config/tools.json` 的顶层 `permissions` 为每个启用工具声明权限：

- `allow`：无需确认直接执行。
- `ask`：执行前询问，可选择仅本次允许、本会话允许或拒绝。
- `deny`：始终拒绝执行。

当前默认允许读取和搜索，`edit_file`、`write_file` 与运行命令需要审批。文件工具的会话授权按工具和文件路径保存，进程退出后失效；删除命令、`git clean` 和 `git reset --hard` 始终拒绝，不能被会话授权覆盖。

审批与 OS 沙箱是两层机制：审批决定用户是否同意尝试执行，Seatbelt 决定获批进程技术上最多能访问什么。系统 `deny` 不会被用户审批覆盖，用户批准也不会扩大 Seatbelt 的文件和网络边界。

## macOS 沙箱

`run_command` 当前只支持 macOS。CLI 启动时检查 `/usr/bin/sandbox-exec` 和 `sandbox/macos-workspace.sb`，任一不可用都会失败关闭。

普通单元测试：

```bash
npm test
npm run typecheck
```

真实 Seatbelt 边界测试必须从未被其他沙箱包裹的普通 Terminal 执行：

```bash
npm run test:sandbox
```

Seatbelt 只保护 `run_command` 启动的子进程。内置 `read_file`、`search_files`、`edit_file` 和 `write_file` 仍使用应用层工作区路径校验，不会自动进入 OS 沙箱。

## Token 用量

每次模型请求返回标准 `usage` 时，Agent 会累计输入、输出和总 Token。输入 `exit` 或 `quit` 结束 CLI 会话后，会打印本次进程内的用量汇总；未返回 `usage` 的兼容供应商按 0 统计。

## 配置说明

在 `config/settings.toml` 中设置 `active_provider`，并在对应的 `providers` 配置段填写 `AGENT_API_KEY`、`base_url` 和 `model`。`agent.max_steps` 用于限制单次对话最多执行的模型步骤数，必须是正整数。
