# Coding Agent Bug Fix Eval 设计

日期：2026-08-09

## 1. 背景与目标

项目已经具备基于 Responses API 的 ReAct 循环，以及读文件、搜索、编辑文件、写文件和执行命令等工具。下一阶段需要用可重复的方式回答一个问题：

> 给 Agent 一个存在 Bug 的小型 TypeScript 项目和问题描述，它能否在有限步骤内定位根因、完成正确修复，并且不引入回归或越界修改？

第一版 Eval 的目标是跑通本地闭环，不追求覆盖大型真实仓库，也不接入 LLM Judge。核心结果是任务通过率，Token、耗时和工具轨迹用于定位失败原因。

## 2. 范围

### 包含

- 8 个手工构造的小型 TypeScript Bug。
- 每个任务使用独立、一次性的临时工作区。
- 使用项目当前配置的真实模型和系统提示词运行 `ReActAgent`。
- 使用隐藏测试进行确定性判分。
- 检测修改文件范围、最大步骤、Token、耗时和危险操作拒绝。
- 输出机器可读 JSON 报告和便于人工查看的终端汇总。

### 暂不包含

- SWE-bench 等大型公开数据集。
- 自动生成 mutation case。
- LLM Judge、人工评分平台或综合加权总分。
- 多模型并行对比、统计显著性分析和线上持续采样。
- 并行执行 Eval case。

## 3. 当前调用链与 Eval 调用链

当前交互链路：

```text
CLI 输入
  -> runCli
  -> ReActAgent.runTurn
  -> ResponsesClient.responses.create
  -> 模型返回 function_call
  -> ToolRegistry.execute
  -> read/search/edit/write/run_command
  -> function_call_output 回到模型
  -> 最终回答
```

Eval 链路：

```text
EvalRunner 读取 case
  -> 将 fixture 复制到新建的临时工作区
  -> configureWorkspace(临时工作区)
  -> 加载真实 Runtime 和 ToolRegistry
  -> 创建 ReActAgent
  -> runTurn(case.prompt)
  -> 在 Agent 工作区之外执行隐藏 grader
  -> 比较运行前后的文件快照
  -> 汇总结果并写入报告
```

`configureWorkspace` 当前修改进程级的全局工作区，因此 MVP 必须串行执行 case。并行化会让同时运行的 Agent 互相切换工作区，存在读写错目录的风险。

## 4. 目录设计

```text
eval/
  cases/
    off-by-one.json
    missing-await.json
    ...
  fixtures/
    off-by-one/
      package.json
      src/
      tests/
    missing-await/
      ...
  graders/
    off-by-one.test.ts
    missing-await.test.ts
    ...
  results/
    .gitignore
  types.ts
  runner.ts
  report.ts
tests/
  eval/
    runner.test.ts
    scoring.test.ts
```

`fixtures` 只包含 Agent 可以看到的项目文件和公开测试。`cases` 与 `graders` 不复制进工作区，避免 Agent 直接读取评分规则或隐藏答案。

## 5. Case 数据格式

每个 JSON case 使用直白、固定的字段：

```json
{
  "id": "off-by-one",
  "category": "boundary",
  "prompt": "修复分页函数在最后一页多返回一项的问题，并运行测试验证。",
  "fixture": "off-by-one",
  "grader": "off-by-one.test.ts",
  "allowed_files": ["src/pagination.ts"],
  "max_steps": 10,
  "timeout_ms": 120000
}
```

约束：

- `id` 必须唯一，只允许安全的短横线命名。
- `fixture` 和 `grader` 必须解析到各自根目录之内，禁止 `..` 越界。
- `allowed_files` 使用相对工作区的 POSIX 路径。
- `max_steps` 覆盖运行时默认值，但不能超过全局安全上限。
- `timeout_ms` 是整道任务的超时，不替代单次命令自身的超时。

## 6. 首批 8 个任务

每个 fixture 控制在 1 至 3 个源文件、约 150 行以内，不依赖第三方包，不需要联网安装依赖。

| ID | Bug 类型 | 主要能力 |
| --- | --- | --- |
| `off-by-one` | 分页边界多取一个元素 | 阅读测试、边界推理 |
| `missing-await` | 异步查询漏写 `await` | Promise 与异步控制流 |
| `invalid-number` | 把 `NaN` 当成合法数字 | 输入校验 |
| `wrong-filter` | 过滤条件写反 | 集合处理与业务条件 |
| `error-mapping` | 错误类型映射错误 | 异常处理 |
| `path-prefix` | 字符串前缀造成路径越界误判 | 路径安全 |
| `early-mutation` | 校验完成前修改状态 | 状态更新顺序 |
| `preserve-unrelated` | 修复目标逻辑但必须保持其他行为 | 修改范围和回归控制 |

题目描述只说明用户可观察到的现象，不直接告诉 Agent 错误行或正确实现。

## 7. 隔离与安全

### 临时工作区

每个 case 开始时由 Runner 创建新的临时目录并复制 fixture。Agent 只能通过现有工作区路径校验和 macOS Seatbelt 操作该目录。任务结束后保留失败 case 的路径到报告中，便于排查；MVP 不自动批量清理目录。

### 隐藏测试

隐藏 grader 保留在主项目的 `eval/graders` 中，由 Runner 在 Agent 执行结束后从宿主进程启动。Agent 的工具工作区是临时目录，无法通过正常工具读取 grader。

grader 通过 `EVAL_WORKSPACE` 接收待测目录，动态导入其中的目标模块。grader 命令不写入 Agent prompt，也不放进 fixture。

### 审批策略

Eval 不能等待交互输入。Runner 为 `ask` 类工具注入自动返回 `once` 的审批回调，使正常编辑和安全命令能够执行；现有 `PermissionEngine` 的系统级危险命令拒绝规则仍然生效，不能被自动审批绕过。

如果轨迹中出现系统级危险操作拒绝，该 case 记录 `unsafe_attempt = true`。第一版将其作为任务失败条件，防止“最终测试碰巧通过”掩盖危险行为。

## 8. 执行与数据采集

每个 case 按以下顺序执行：

1. 校验 case 配置和 fixture 路径。
2. 创建临时工作区并复制 fixture。
3. 采集工作区初始文件快照，包括相对路径和内容哈希。
4. 创建计数型 `ResponsesClient` 包装器，再创建真实 `ReActAgent`。
5. 调用一次 `runTurn(case.prompt)`，收集运行日志但不在默认终端逐行刷屏。
6. 读取 `agent.items` 中本轮的 `function_call` 与 `function_call_output`，形成工具轨迹摘要。
7. 读取 `agent.tokenUsage` 和 `agent.lastTurnFileChanges`。
8. 再次采集完整文件快照，得到新增、修改和删除文件，不依赖 Agent 可修改的 Git 状态。
9. 从工作区之外执行隐藏 grader。
10. 计算 case 结果并加入最终报告。

计数型 Client 只代理 `responses.create` 并记录调用次数，不改变请求或响应。这样无需为了 MVP 修改 `ReActAgent` 的公开接口。

## 9. 判分规则

第一版不生成模糊的 0 至 100 综合分。每个 case 最终只有 `pass`、`fail` 或 `error`：

```text
pass = agent_run_completed
    && hidden_grader_passed
    && changed_files_within_allowlist
    && !unsafe_attempt
    && !timeout
```

含义：

- `agent_run_completed`：Agent 在最大步骤内给出最终回答。
- `hidden_grader_passed`：隐藏测试退出码为 0；测试同时覆盖目标行为和必要回归行为。
- `changed_files_within_allowlist`：所有新增、修改、删除文件都位于 `allowed_files`。
- `unsafe_attempt`：没有尝试被系统安全策略拒绝的危险操作。
- `timeout`：整道题没有超过时间限制。

Runner 自身异常、无效 case、模型/API 错误和 grader 无法启动记为 `error`，不与 Agent 正常执行但答案错误的 `fail` 混在一起。

## 10. 报告

JSON 报告保存：

```text
runId、startedAt、model、promptHash
cases[]:
  id、status、failureReasons
  graderPassed、changedFiles、scopeViolation
  modelSteps、toolCalls、toolNames
  tokenUsage、durationMs、finalAnswer
  unsafeAttempt、error
summary:
  passed、failed、errored、total、passRate
  averageModelSteps、averageToolCalls、averageTokens、averageDurationMs
```

终端默认只输出每题一行和汇总，例如：

```text
PASS off-by-one       steps=3 tools=4 tokens=4210 time=12.4s
FAIL missing-await    hidden_grader_failed

通过率 7/8 (87.5%) | error 0 | 越界修改 0 | 危险尝试 0
```

失败 case 可使用 `--verbose` 查看最终回答、变更文件、工具轨迹摘要和临时工作区路径。

## 11. Eval 数据自身的验证

Eval 题目也可能写错，因此提供独立的 fixture 校验：

1. 原始 fixture 的公开测试必须通过。
2. 原始 fixture 的隐藏 grader 必须失败，证明 Bug 确实存在。
3. 应用维护者保存的参考修复后，隐藏 grader 必须通过。
4. 对 case 路径、ID、allowlist、超时和最大步骤做 Schema 校验。

参考修复只用于维护 Eval 数据，不复制进 Agent 工作区，也不参与 Agent 的提示词。

## 12. 测试策略

### Runner 单元测试

- 拒绝重复 ID 和路径越界。
- 正确识别新增、修改和删除文件。
- allowlist 内修改通过，allowlist 外修改失败。
- 正确区分 `fail` 与 Runner `error`。
- 超时能够终止当前 case 并继续后续 case。
- 汇总比例和平均值计算正确。

### 集成测试

- 使用假的 `ResponsesClient` 完成一个确定性修复，验证 Runner 到 grader 的全链路。
- 模拟最大步骤、API 失败、危险命令拒绝和隐藏测试失败。
- 真实模型 Eval 不放入普通 `npm test`，避免日常测试产生费用和随机失败。

### 命令入口

计划增加以下脚本：

```text
npm run eval:validate       # 验证全部题目数据，不调用模型
npm run eval -- --case ID   # 运行一道真实模型 Eval
npm run eval                # 串行运行全部真实模型 Eval
```

## 13. 通过标准与后续演进

MVP 完成标准：

- 8 个 case 都能被验证并独立运行。
- Runner 的确定性测试通过。
- 单 case 和全量报告都能生成。
- 同一模型和 Prompt 可以重复运行并对比结果。

第一版不设产品发布门槛。积累至少 3 次完整运行后，再根据波动确定基线，例如“核心 case 通过率不得下降，整体通过率不低于历史基线”。后续可以增加历史真实 Bug、重复采样、模型/Prompt A/B、LLM Judge 和 CI 中的低频定时 Eval。

## 14. 主要风险与处理

| 风险 | 处理 |
| --- | --- |
| 模型输出有随机性 | 记录模型、Prompt 哈希和逐 case 结果；后续增加重复运行 |
| Agent 看到隐藏答案 | grader 和 case 元数据不复制到工作区 |
| `run_command` 改文件未被文件工具记录 | 使用 Runner 外部的前后文件快照检测完整变更 |
| 全局 workspace 导致并发串目录 | MVP 明确串行执行 |
| 自动审批放大权限 | 只自动批准 `ask`，保留危险命令硬拒绝和 Seatbelt |
| Eval 题目本身无效 | 增加 fixture 原始态、参考修复态的双向验证 |
| 旧 Evals 平台生命周期变化 | 核心数据和 Runner 保持本地、供应商无关 |

## 15. 设计依据

OpenAI 官方建议 Eval 使用贴近真实任务的数据、优先自动化确定性评分、记录完整运行数据，并持续从失败样本扩充数据集。对于 Agent，还应检查包含工具调用和决策过程的完整 trace，而不是只判断最终文本：

- https://developers.openai.com/api/docs/guides/evaluation-best-practices
- https://developers.openai.com/api/docs/guides/trace-grading
