# 上下文 Token 水位警告设计

## 1. 背景

Coding Agent 已经能够持久化和恢复 Session，但恢复后会把所有完整消息继续加入 `ReActAgent.messages`。每次模型调用都会再次发送这些消息，当前没有上下文窗口水位判断。

现有 `TokenUsage.inputTokens` 是整个进程中多次模型调用的输入 Token 累计值，适合统计消耗，不代表最新一次请求实际占用的上下文大小。

## 2. 目标

第一版只增加上下文水位警告：

1. 当前启用的 Provider 显式配置模型上下文窗口。
2. 使用模型响应中的 `usage.prompt_tokens` 作为最新一次请求的实际上下文用量。
3. 当用量达到或超过上下文窗口的 80% 时输出警告。
4. 保持现有累计 Token 统计行为不变。

## 3. 非目标

第一版不实现：

- 请求前 Token 估算；
- 自动或手动 Compact；
- 达到阈值后阻止模型请求；
- 消息删除或裁剪；
- Token 水位持久化；
- 模型名称与上下文窗口的内置映射；
- Provider 专用 Tokenizer。

## 4. 配置

当前启用的 Provider 必须提供 `context_window`：

```toml
[providers.deepseek]
model = "deepseek-v4-flash"
context_window = 1_000_000
```

`context_window` 必须是正整数。缺失、为零、负数或小数时，CLI 在启动阶段返回配置错误，不发送模型请求。

上下文窗口来自模型供应商规格，不作为 Chat Completions 请求参数发送。

## 5. 数据流

```text
settings.toml
  context_window
        ↓
loadRuntime() 读取并校验
        ↓
ReActAgent 保存 contextWindow
        ↓
模型返回 usage.prompt_tokens
        ↓
计算 prompt_tokens / contextWindow
        ↓
达到 80% 时通过本轮 output() 输出警告
```

第一版不创建独立 `ContextManager` 类。水位逻辑保留在 `ReActAgent` 内；实现 Compact 时再根据实际职责提取组件。

## 6. 行为

警告格式：

```text
[Context] 警告：上下文已使用 812000/1000000 Tokens（81.2%）
```

规则：

- 低于 80% 时不增加日志；
- 等于或高于 80% 时，每次模型响应后输出警告；
- `usage.prompt_tokens` 缺失或非法时，本轮水位视为未知，不警告也不中断；
- 警告不改变 ReAct 循环、消息、工具调用或 Session 持久化；
- 累计输入、输出和总 Token 统计继续按原逻辑更新。

## 7. 改动范围

- `config.ts`：读取和校验 `context_window`；
- `runtime.ts`：根据最新 `prompt_tokens` 计算并输出水位警告；
- `config/settings.example.toml`：增加配置示例；
- `tests/config.test.ts`：覆盖有效和非法配置；
- `tests/runtime.test.ts`：覆盖水位边界和缺失 usage。

SQLite Schema 和 SessionStore 不修改。

## 8. 测试

核心边界：

| 最新 `prompt_tokens` | `context_window` | 预期 |
|---:|---:|---|
| 799999 | 1000000 | 不警告 |
| 800000 | 1000000 | 警告并显示 `80.0%` |
| 缺失 | 1000000 | 不警告、不中断 |

同时运行完整测试和 TypeScript 类型检查，确认现有 Token 累计、ReAct、CLI 与 Session 行为不变。
