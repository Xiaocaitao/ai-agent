# SWE-bench 指标基线与 Pi 对照评测设计

## 目标

让每一次 SWE-bench 评测都沉淀为可比较的基础数据；并在同一批任务、同一仓库提交和同一官方 grader 下，运行一次 Pi Coding Agent + DeepSeek V4 Flash，作为 Coding Agent 的追赶基线。

不自动提交任何改动。

## 范围

本次覆盖两件事：

1. 为 Coding Agent 的每题结果和批次汇总保存统一指标。
2. 接入用户已安装的 `/Users/titusliu/Documents/ai-agent/pi/pi-test.sh`，以无交互方式运行 Pi，并生成同格式结果。

不在本次改动中实现跨 provider 的通用代理，也不修改 SWE-bench 官方 grader。

## 评测调用链

```text
固定 SWE-bench task + base_commit
  -> workspace 准备
  -> 目标 Agent Worker（Coding Agent 或 Pi）
  -> run/session.sqlite、agent.log、agent 输出
  -> 官方 SWE-bench Grader
  -> grade/eval.log
  -> task metrics.json
  -> 批次 summary.json
  -> Eval UI 读取、筛选、对比
```

每个 task 独立 workspace、独立 Worker 容器、独立 Grader 容器。任务之间不共享会话或修改后的代码。

## 统一数据格式

每题在 `<results>/<runId>/<taskId>/metrics.json` 写入结构化指标，批次 `summary.json` 写汇总与每题索引。核心字段：

```json
{
  "schemaVersion": 1,
  "agent": {
    "id": "coding-agent | pi",
    "version": "可获取时记录",
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "executionProfile": "host-model-proxy | direct-provider-egress"
  },
  "correctness": {
    "resolved": true,
    "failToPass": { "passed": 1, "total": 1 },
    "passToPass": { "passed": 21, "total": 21 }
  },
  "durationMs": {
    "workspacePrepare": 0,
    "workerStartup": 0,
    "agent": 0,
    "grading": 0,
    "total": 0
  },
  "agentBehavior": {
    "steps": 0,
    "toolCalls": 0,
    "toolCallsByName": {},
    "toolFailures": 0,
    "modelRequests": 0,
    "inputTokens": null,
    "outputTokens": null,
    "totalTokens": null,
    "contextCompactions": null,
    "filesChanged": 0,
    "verificationCommands": 0
  },
  "artifacts": {
    "session": "run/session.sqlite | run/pi-session.jsonl | null",
    "agentLog": "run/agent.log",
    "graderLog": "grade/eval.log"
  }
}
```

`null` 表示该 Agent 原生没有可靠数据，而不是 0。这样不会把“不可观测”误认为“没有消耗”。

## Coding Agent 指标采集

现有链路会在 workspace 准备、Worker 运行、评分三个边界计时。

Worker 结束后，离线读取同题 `run/session.sqlite`：

- `messages`：统计工具调用、工具名、工具失败、模型响应次数与步骤数；
- `compactions`：统计上下文压缩次数；
- Worker 结果：token 使用、改动文件数、最终状态；
- Grader 结果：F→P、P→P、resolved。

不会为了指标再请求模型。

## Pi 基线执行

Pi 已由用户维护在 `/Users/titusliu/Documents/ai-agent/pi/pi-test.sh`。评测 runner 不读取 Pi 的凭据配置，也不将密钥写入命令、日志或结果文件。

每题会：

1. 使用同一个 SWE-bench task 的 `base_commit` 创建独立 workspace；
2. 在与 Coding Agent 相同的 SWE-bench 环境镜像中执行 Pi；
3. 用 `--print`、`--mode json`、`--approve` 与独立 `--session-dir` 运行，禁用扩展、skills、prompt templates 和 task 仓库的 `AGENTS.md`/`CLAUDE.md` 注入；
4. 只启用 `read,bash,edit,write,grep,find,ls` 工具；
5. 将 Pi 的 JSON 事件、session 和标准输出保存到该题 `run/`；
6. 由完全相同的官方 grader 评分。

Pi 直接调用 DeepSeek，因此 Pi Worker 必须有网络访问，并在容器运行时从当前环境注入 `DEEPSEEK_API_KEY`。这是与 Coding Agent 的显式差异：后者 Worker 无网络、模型请求由宿主机 Model Proxy 处理。两个结果都会记录 `executionProfile`，UI 也必须展示该差异；因此它们适合比较任务正确性、耗时、工具行为和成本，但不应被描述为相同安全策略下的对照。

Pi 的 `--approve` 在当前版本中表示信任本题目录的项目本地资源，等价于对启动时审批问题注入 `yes`。它不是逐次工具调用的确认开关；Pi 在 `--print` 无交互模式下执行工具时不会等待 stdin。因此 runner 必须显式传递 `--approve`，不能通过 `yes | pi` 伪造交互。对 `bash`、`edit`、`write` 的实际限制仍由 Docker 容器、只挂载的 task workspace 和结果目录提供。

Docker 的普通网络模式无法可靠限制到 DeepSeek 单一域名。本次不伪称“只允许 DeepSeek”；如果后续需要安全同级对比，再实现通用 HTTP 模型代理，并使 Pi Worker 网络为 `none`。

## 兼容与历史数据

- 现有 `summary.json` 字段保持不变，只增加 `metrics`/`agent` 等字段；旧运行仍可被 UI 打开。
- 旧的 Coding Agent 基线可离线回填：token、会话工具调用、压缩次数、Worker 活跃时长、正确性。
- 不能从历史工件准确恢复的阶段耗时标为 `null`，并标注 `source: historical-estimate`。

## 验证

1. 新增纯函数单元测试：指标汇总、空值语义、Pi JSON 事件解析、密钥脱敏。
2. 批次 runner 集成测试：一题成功和一题失败都写出 `metrics.json` 与汇总。
3. 使用 mock Pi 进程验证命令参数、工作目录、session 目录和环境白名单；不在自动测试中调用真实模型。
4. 手工运行一个 Pi task 后，执行官方 grader，确认 metrics 与日志可在 UI 打开。
5. 运行 `npm test` 与 `npm run typecheck`。

## 明确不做

- 不读取、不复制、不持久化任何 API Key。
- 不自动提交或清理用户已有 workspace、results、Pi 安装目录。
- 不修改 gold patch 或隐藏测试。
