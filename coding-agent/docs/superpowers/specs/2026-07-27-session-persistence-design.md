# Session 持久化与当前会话输入历史设计

## 1. 背景

当前 `ReActAgent` 只在进程内维护 `messages`：

```text
CLI 启动
  → 创建 ReActAgent
  → messages 只存在于内存
  → 进程退出
  → 会话历史全部丢失
```

本设计为 Coding Agent 增加本地 Session 持久化，使用户能够在进程退出后恢复完整对话，并在终端中通过 `↑`、`↓` 浏览当前 Session 的历史提问。

本阶段只解决会话连续性，不实现上下文压缩和跨会话长期记忆。

## 2. 目标

第一期必须实现：

1. 每次新会话生成唯一 `session_id`。
2. 用户可以通过 `--resume <session-id>` 恢复指定会话。
3. 用户可以通过 `--continue` 恢复当前工作区最近一次会话。
4. 恢复时只向模型加载已经完整结束的 Turn。
5. 未完成的 Turn 被标记为 `interrupted`，不自动重放工具调用。
6. `↑`、`↓` 只浏览当前 Session 的历史提问。
7. 权限审批输入、退出命令和空输入不进入提问历史。
8. SQLite 持久化失败时停止当前流程，不能继续形成只存在于内存的历史。

## 3. 非目标

第一期不实现：

- 自动上下文压缩；
- 跨 Session 长期记忆；
- Session 分支或 Fork；
- 会话标题自动生成；
- 中断工具调用自动重放；
- SQLite 内容加密；
- 自动删除或归档旧会话；
- 同一个 Session 的多进程并发写入；
- JSONL Event Log；
- 服务端或多用户数据库。

## 4. 方案选择

### 4.1 JSONL 单文件

每个 Session 使用一个追加写 JSONL 文件。它易于人工检查，也适合事件流，但查询“当前工作区最近一次会话”、分页和未来统计需要额外索引。

### 4.2 SQLite 单数据源

Session、Turn、Message 都存入一个 SQLite 数据库。它支持事务、索引、外键和按工作区查询，适合当前单机 CLI。

### 4.3 SQLite 元数据加 JSONL 正文

SQLite 管理 Session 元数据，JSONL 保存完整事件。这适合更成熟的归档与事件系统，但必须解决两个持久化目标之间的崩溃一致性。

### 4.4 决策

第一期选择 **SQLite 单数据源**。

原因：

- 当前项目是单进程、单用户 CLI；
- 一个数据源更容易保证一致性；
- 能直接支持 `--resume`、`--continue` 和当前 Session 输入历史；
- 后续仍可以通过 `SessionStore` 边界替换为其他存储；
- 不提前引入 JSONL 索引、对账和修复机制。

## 5. 总体调用链

### 5.1 新建会话

```text
CLI 启动
  → 解析并规范化 workspace
  → 打开 SQLite 并执行迁移
  → SessionStore.create()
  → 生成 session_id
  → 创建 ReActAgent
  → 打印 Session ID
  → 进入 REPL
```

### 5.2 恢复会话

```text
CLI 启动
  → 解析 --resume <id> 或 --continue
  → SessionStore.load()
  → 校验 workspace
  → 将遗留 running Turn 标记为 interrupted
  → 加载 completed Turn 的消息
  → 加载当前 Session 的历史提问
  → 当前 system prompt + 已完成历史消息
  → 创建 ReActAgent
  → 进入 REPL
```

### 5.3 执行一轮对话

```text
用户输入
  → 创建 running Turn
  → 保存 user message
  → 请求模型
  → 保存 assistant message
  → 如果模型调用工具：
       保存 assistant tool_call
       执行工具
       保存 tool result
  → 保存最终 assistant message
  → Turn 标记为 completed
```

## 6. 存储位置与安全

数据库默认存放在 Agent 自己的状态目录：

```text
~/.coding-agent/state.sqlite
```

数据库不放入用户工作区，避免：

- 数据库被提交进 Git；
- Agent 通过工作区写工具修改自己的会话历史；
- 每个项目各自维护无法统一查询的数据库文件。

状态目录应尽量设置为当前用户私有：

- 目录权限：`0700`；
- 数据库文件权限：`0600`。

数据库会保存原始提问、模型回答和工具输出。SQLite 打开、初始化或迁移失败时，CLI 必须终止，不能降级成无持久化模式。

## 7. SQLite 配置与版本

启动时启用：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

使用 `PRAGMA user_version` 管理数据库版本。第一版数据库版本为 `1`。

未来修改表结构时，必须按旧版本顺序迁移，不能假设数据库为空。

第一版优先使用 Node.js 内置的 `node:sqlite`，不新增 npm 依赖。SQLite 访问隐藏在 `SessionStore` 内部，以便未来替换实现。

## 8. 数据模型

### 8.1 sessions

```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_path TEXT NOT NULL,
    title TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_model TEXT,
    system_prompt_hash TEXT
);

CREATE INDEX sessions_workspace_updated_idx
ON sessions(workspace_path, updated_at DESC);
```

字段含义：

- `id`：UUID；
- `workspace_path`：经过规范化的工作区绝对路径；
- `title`：第一期允许为空；
- `created_at`、`updated_at`：Unix 毫秒时间戳；
- `last_model`：最近一次运行使用的模型；
- `system_prompt_hash`：用于检测恢复时系统提示是否变化。

Session 是否存在未完成工作由 `turns.status` 推导，不在 `sessions` 中重复保存。

### 8.2 turns

```sql
CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    user_input TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    FOREIGN KEY (session_id)
        REFERENCES sessions(id)
        ON DELETE CASCADE,
    UNIQUE (session_id, sequence)
);

CREATE INDEX turns_session_sequence_idx
ON turns(session_id, sequence);
```

`user_input` 同时用于：

- 表示该 Turn 的原始用户提问；
- 为终端 `↑`、`↓` 提供历史输入。

### 8.3 messages

```sql
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    role TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id)
        REFERENCES sessions(id)
        ON DELETE CASCADE,
    FOREIGN KEY (turn_id)
        REFERENCES turns(id)
        ON DELETE CASCADE,
    UNIQUE (session_id, sequence)
);

CREATE INDEX messages_session_sequence_idx
ON messages(session_id, sequence);
```

`payload_json` 保存完整 `AgentMessage`，例如：

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_123",
      "function": {
        "name": "read_file",
        "arguments": "{\"path\":\"README.md\"}"
      }
    }
  ]
}
```

`role` 单独存列用于查询和诊断，恢复时以 `payload_json` 为完整消息来源。

## 9. Runtime 边界

`ReActAgent` 不直接执行 SQL。它只通过会话记录接口报告生命周期事件：

```ts
export type SessionRecorder = {
  startTurn(userInput: string): Promise<string>;
  appendMessage(turnId: string, message: AgentMessage): Promise<void>;
  completeTurn(turnId: string): Promise<void>;
  failTurn(turnId: string, error: unknown): Promise<void>;
};
```

`ReActAgent` 构造函数增加可选历史消息：

```ts
initialMessages?: AgentMessage[]
```

恢复后的内存上下文为：

```text
当前 system message
+ SQLite 中 completed Turn 的历史 messages
```

职责边界：

- `ReActAgent`：推进模型和工具循环；
- `SessionRecorder`：接收运行时会话事件；
- `SQLiteSessionStore`：建库、迁移、查询和写入；
- `CLI`：选择新建或恢复 Session，并管理终端历史。

## 10. 持久化顺序

每轮必须按以下顺序写入：

1. 创建状态为 `running` 的 Turn；
2. 保存 user message；
3. 请求模型；
4. 保存模型返回的 assistant message；
5. assistant 包含工具调用时，先保存 tool call，再执行工具；
6. 工具完成后保存 tool result；
7. 保存最终 assistant message；
8. 将 Turn 更新为 `completed`。

持久化失败时：

- 工具尚未执行：立即停止当前轮；
- 工具已经执行：停止后续流程，并提示工作区可能已经发生修改；
- 禁止继续维护只存在于内存中的后续消息。

`messages.sequence` 必须按 Session 单调递增，恢复时始终按它排序。

## 11. CLI 语义

### 11.1 新建会话

```bash
npm start -- .
```

输出至少包含：

```text
ReAct Agent 已启动
Session: <session-id>
工作目录: <workspace>
```

### 11.2 恢复指定会话

```bash
npm start -- . --resume <session-id>
```

规则：

1. Session 不存在时明确报错；
2. Session 的 `workspace_path` 与当前工作区不一致时拒绝恢复；
3. 不允许静默创建同 ID 的新 Session；
4. system prompt 哈希改变时允许恢复，但打印警告；
5. 使用当前运行配置中的模型，并更新 `last_model`；
6. 只加载 `completed` Turn 的消息。

### 11.3 恢复当前工作区最近会话

```bash
npm start -- . --continue
```

查询：

```sql
SELECT id
FROM sessions
WHERE workspace_path = ?
ORDER BY updated_at DESC
LIMIT 1;
```

当前工作区没有历史 Session 时明确报错。

`--resume` 与 `--continue` 互斥。

## 12. system prompt 处理

旧 system message 不作为普通历史恢复。

恢复时使用：

```text
当前 system prompt
+ 历史 user / assistant / tool messages
```

创建 Session 时保存 `system_prompt_hash`。恢复时：

- 哈希相同：正常恢复；
- 哈希不同：允许恢复，并提示系统规则已经变化。

这样修改 Prompt 后不会被旧 system message 永久锁住，同时保留可观察性。

## 13. 中断与失败恢复

恢复 Session 时如果发现 `running` Turn：

1. 将其更新为 `interrupted`；
2. 保留它的数据库记录用于诊断；
3. 不把该 Turn 的消息送入模型；
4. 只恢复到上一个 `completed` Turn；
5. 提示用户检查工作区。

提示示例：

```text
检测到上一轮未完成，已恢复到最后一个完整 Turn。
工具可能已经修改工作区，请先检查 git diff。
```

第一期不自动重放工具调用，因为无法可靠判断工具是否已经执行、是否只执行了一部分，以及重复执行是否安全。

`failed` Turn 与 `interrupted` Turn 一样，不进入恢复后的模型上下文，但它们的 `user_input` 可以进入终端输入历史。

## 14. 当前 Session 输入历史

恢复 Session 时查询：

```sql
SELECT user_input
FROM turns
WHERE session_id = ?
  AND user_input <> ''
ORDER BY sequence DESC
LIMIT 100;
```

readline 初始化：

```ts
createInterface({
  input: stdin,
  output: stdout,
  history: questions,
  historySize: 100,
  removeHistoryDuplicates: true,
});
```

交互规则：

- 新 Session 的输入历史为空；
- 恢复 Session 后，第一次按 `↑` 显示最近一次提问；
- 继续按 `↑` 向更早提问移动；
- 按 `↓` 向更新提问移动；
- 历史只填充输入框，不自动发送；
- 历史只属于当前 Session；
- 数据库保留重复提问，readline 展示时去重；
- `failed` 或 `interrupted` Turn 的提问仍可出现，方便用户重新提交。

以下输入不能进入 readline 历史：

- 权限审批的 `y`、`s`、`n`；
- 无效审批输入；
- `exit`、`quit`；
- 空输入。

当前 CLI 使用同一个 readline 处理用户问题和权限审批，因此需要增加一个小型终端输入包装层，区分：

```text
askUserQuestion() → 允许保留在历史中
askApproval()     → 回答后从 readline history 中移除
```

## 15. 并发边界

第一期不支持两个进程同时恢复并写入同一个 Session。

SQLite 的唯一约束和事务用于避免数据库结构损坏，但不承诺两个 Agent 同时写同一对话时的业务顺序正确。README 必须记录该限制。

如未来需要多进程支持，应单独设计 Session lease、owner token 和过期恢复，不在第一期加入不完整的锁机制。

## 16. 预计文件改动

新增：

```text
session/store.ts
tests/session/store.test.ts
```

修改：

```text
runtime.ts
cli.ts
agent.ts
tsconfig.json
README.md
tests/runtime.test.ts
tests/cli.test.ts
```

职责：

- `session/store.ts`：SQLite 初始化、迁移、Session/Turn/Message CRUD；
- `runtime.ts`：接收初始历史，发出会话生命周期事件；
- `cli.ts`：解析 `--resume`、`--continue`，恢复会话与 readline 历史；
- `agent.ts`：继续作为最薄的进程入口；
- `README.md`：记录命令、数据库位置、安全边界和并发限制。

第一期不额外拆分 Repository、DAO、Service 等层级。

## 17. 错误处理

以下情况必须 fail closed：

- SQLite 文件无法打开；
- 数据库迁移失败；
- Session ID 不存在；
- Session 与当前 workspace 不匹配；
- 消息 JSON 无法解析；
- 保存 user、assistant 或 tool message 失败；
- 更新 Turn 状态失败。

错误消息必须包含足够定位信息，例如 Session ID、Turn ID 或 Message ID，但不能把完整敏感消息内容打印到错误日志。

## 18. 测试设计

### 18.1 SessionStore

- 创建 Session 后 ID 唯一；
- 不同 Session 的消息互不影响；
- 消息按 `sequence` 恢复；
- 能找到当前 workspace 最近的 Session；
- workspace 不匹配时拒绝恢复；
- 非法 `payload_json` 恢复时明确失败；
- 数据库版本初始化正确。

### 18.2 Runtime

- user、assistant、tool 消息按运行顺序记录；
- 最终回答保存后 Turn 标记为 `completed`；
- 模型异常时 Turn 标记为 `failed`；
- 工具返回失败 Observation 时仍保存 tool message；
- 持久化失败后不继续模型或工具流程；
- 初始历史消息位于当前 system message 之后。

### 18.3 恢复

- 只加载 `completed` Turn；
- 遗留 `running` Turn 被标记为 `interrupted`；
- `failed`、`interrupted` Turn 不进入模型上下文；
- system prompt 变化时产生警告；
- `--resume` 与 `--continue` 互斥；
- 找不到 Session 时不会创建新 Session。

### 18.4 输入历史

- 只加载当前 Session 的提问；
- 最近提问对应第一次 `↑`；
- 最多加载 100 条；
- 权限审批回答不进入历史；
- `exit`、`quit` 和空输入不进入历史；
- `failed`、`interrupted` Turn 的提问可以进入历史；
- 新 Session 不加载其他 Session 的提问。

真实方向键行为优先使用窄范围 PTY 集成测试；如果 CI 环境不稳定，则保留 readline 初始化单元测试和人工验收步骤。

## 19. 人工验收

```text
1. 启动 Agent，记录打印出的 Session ID。
2. 连续提出两个问题。
3. 输入 exit。
4. 使用 --resume <id> 重启。
5. 询问“我刚才第二个问题是什么”，Agent 能结合历史回答。
6. 在输入框按 ↑，显示第二个问题。
7. 再按 ↑，显示第一个问题。
8. 触发一次权限审批并输入 y。
9. 下一次按 ↑，不会看到 y。
10. 强制中断一次运行中的 Turn。
11. 再次恢复时，CLI 提示中断并回到最后一个完整 Turn。
12. 检查 git diff，确认中断前可能发生的工具副作用可见。
```

## 20. 验收标准

实现完成必须同时满足：

1. 新 Session 有唯一且可显示的 ID；
2. 正常退出后能按 ID 恢复完整历史；
3. `--continue` 能恢复当前工作区最近会话；
4. 不完整 Turn 不会进入模型上下文；
5. 中断工具调用不会被自动重放；
6. `↑`、`↓` 只浏览当前 Session 的提问；
7. 权限审批与退出命令不会污染提问历史；
8. SQLite 故障不会静默退化成内存会话；
9. 普通测试和 TypeScript 类型检查通过；
10. README 明确记录数据位置、隐私与并发边界。
