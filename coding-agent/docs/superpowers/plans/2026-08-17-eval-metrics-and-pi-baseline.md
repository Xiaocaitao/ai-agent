# SWE-bench 指标基线与 Pi 对照评测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每次 SWE-bench 运行保存可比较的任务级/批次级指标，并让 Pi + DeepSeek V4 Flash 能以相同 task、workspace 准备和官方 grader 跑出一轮可追溯基线。

**Architecture:** `eval/swebench/metrics.ts` 只负责从 Worker 结果、grader 结果和会话工件归一化指标；batch runner 在 workspace、Agent 和 grader 边界计时并原子写入 `metrics.json`/`summary.json`。Pi 使用独立的 Linux Worker 镜像和 adapter，直接运行本机 Pi 源码的 CLI，但在 Docker 内只可见 task workspace、results、Pi 运行时与运行时传入的 DeepSeek 凭据。

**Tech Stack:** Node.js 24 内置 `node:sqlite`、TypeScript、Docker、SWE-bench 官方 Python grader、Pi CLI JSON mode、Node test runner。

## Global Constraints

- 不读取、记录、打印、持久化 API Key；传入 Docker 时只使用 `--env DEEPSEEK_API_KEY` 的名称形式。
- 当前用户要求不自动 commit；本计划所有“提交”步骤均省略。
- 不删除或覆盖已有 workspace、results、Pi 目录；目录冲突保持现有拒绝语义。
- 默认 Coding Agent Worker 继续 `--network none`；仅 Pi adapter 显式选择 `bridge` 并在指标标记 `direct-provider-egress`。
- Pi 运行必须带 `--approve`、`--print`、`--mode json`、独立 `--session-dir`，并禁用 extensions/skills/prompt templates/context files。
- Pi 没有可靠的 `--max-steps`；记录 `stepLimit: null` 和固定 wall-clock timeout，不能把它伪装成与 Coding Agent 的 100 step 限制相同。
- 自动测试不得调用真实模型、不得依赖 Docker daemon。

---

### Task 1: 定义任务级指标模型与 Coding Agent 会话采集

**Files:**
- Create: `eval/swebench/metrics.ts`
- Create: `tests/swebench/metrics.test.ts`

**Interfaces:**
- Consumes: `run/session.sqlite` 的 `sessions`、`turns`、`messages`、`compactions` 表，以及现有 Worker/Grader JSON。
- Produces: `collectCodingAgentBehavior(sessionPath): AgentBehaviorMetrics`、`createTaskMetrics(input): TaskMetrics`、`summarizeMetrics(metrics): BatchMetricsSummary`。

- [ ] **Step 1: 写失败测试：SQLite 会话能统计工具、失败、轮数和压缩次数**

```ts
test("collectCodingAgentBehavior 统计真实 session 工件", () => {
  const behavior = collectCodingAgentBehavior(databasePath);
  assert.deepEqual(behavior.toolCallsByName, { read_file: 1, run_command: 2 });
  assert.equal(behavior.toolCalls, 3);
  assert.equal(behavior.toolFailures, 1);
  assert.equal(behavior.steps, 2);
  assert.equal(behavior.contextCompactions, 1);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/swebench/metrics.test.ts`

Expected: FAIL，因为 `metrics.ts`、`collectCodingAgentBehavior` 尚不存在。

- [ ] **Step 3: 实现最小指标模块**

```ts
export type AgentBehaviorMetrics = {
  steps: number | null;
  toolCalls: number | null;
  toolCallsByName: Record<string, number> | null;
  toolFailures: number | null;
  modelRequests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  contextCompactions: number | null;
  filesChanged: number | null;
  verificationCommands: number | null;
};
```

使用只读 `DatabaseSync` 查询；只把 `function_call`/`function_call_output` 解析为行为指标。无法可靠判定的字段返回 `null`，而不是 0。

- [ ] **Step 4: 写失败测试：汇总保留 null 语义并计算 resolved/F→P/P→P**

```ts
test("summarizeMetrics 不把不可观测 token 当作零", () => {
  const summary = summarizeMetrics([knownMetric, unknownTokenMetric]);
  assert.equal(summary.totalTokens, null);
  assert.equal(summary.resolvedCount, 1);
});
```

- [ ] **Step 5: 实现 `createTaskMetrics` 与 `summarizeMetrics`，并运行测试**

Run: `npm test -- tests/swebench/metrics.test.ts`

Expected: PASS。

### Task 2: 扩展 DockerSandbox，使 Pi 可以安全地使用宿主机已配置的凭据和网络

**Files:**
- Modify: `eval/swebench/docker_sandbox.ts:97-188`
- Modify: `tests/swebench/docker_sandbox.test.ts`

**Interfaces:**
- Consumes: 新的 `DockerSandboxOptions.network?: "none" | "bridge"` 与 `passthroughEnvironment?: string[]`。
- Produces: Docker argv；默认行为完全不变。

- [ ] **Step 1: 写失败测试：默认无网络不变，Pi 可显式使用 bridge 且不暴露 Key 值**

```ts
test("Pi Worker 只透传凭据名称并显式使用 bridge", () => {
  const args = buildWorkerContainerStartArgs({
    ...baseOptions,
    network: "bridge",
    passthroughEnvironment: ["DEEPSEEK_API_KEY"],
  });
  assert.ok(args.includes("bridge"));
  assert.ok(args.includes("DEEPSEEK_API_KEY"));
  assert.equal(args.some((arg) => arg.includes("secret-value")), false);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/swebench/docker_sandbox.test.ts`

Expected: FAIL，因为新选项尚未声明或生成 argv。

- [ ] **Step 3: 最小实现**

`network` 默认值保持 `none`；仅允许 `none` 和 `bridge`。`passthroughEnvironment` 仅允许精确白名单 `DEEPSEEK_API_KEY`，且生成 `--env DEEPSEEK_API_KEY`，绝不生成 `NAME=value`。

- [ ] **Step 4: 运行 focused tests**

Run: `npm test -- tests/swebench/docker_sandbox.test.ts`

Expected: PASS，已有默认网络安全测试继续通过。

### Task 3: 创建 Pi Docker 运行时与适配器

**Files:**
- Create: `eval/swebench/Dockerfile.pi-worker`
- Create: `eval/swebench/pi_runner.ts`
- Create: `scripts/swebench/pi_task.ts`
- Create: `tests/swebench/pi_runner.test.ts`
- Modify: `package.json`
- Modify: `scripts/swebench/README.md`

**Interfaces:**
- Consumes: `SWEbenchTask`、workspace/result paths、`PiRunOptions`。
- Produces: `runPiSWEbenchTask(options): Promise<PiRunResult>` 与 `parsePiJsonEvents(text): PiBehaviorEvidence`。

- [ ] **Step 1: 写失败测试：Pi argv 必须稳定且具有隔离参数**

```ts
test("buildPiCommand 固定非交互、审批和可复查会话参数", () => {
  assert.deepEqual(buildPiCommand(options), [
    "/opt/pi/pi-test.sh", "--provider", "deepseek", "--model", "deepseek-v4-flash",
    "--print", "--mode", "json", "--approve", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--tools", "read,bash,edit,write,grep,find,ls",
    "--session-dir", "/results/pi-session", expectPrompt,
  ]);
});
```

- [ ] **Step 2: 写失败测试：Pi JSON 事件统计工具而不记录原始凭据**

```ts
test("parsePiJsonEvents 统计 toolCall 和失败结果", () => {
  const evidence = parsePiJsonEvents(jsonLines);
  assert.equal(evidence.toolCalls, 2);
  assert.deepEqual(evidence.toolCallsByName, { bash: 1, read: 1 });
  assert.equal(evidence.toolFailures, 1);
});
```

- [ ] **Step 3: 运行失败测试**

Run: `npm test -- tests/swebench/pi_runner.test.ts`

Expected: FAIL，因为 `pi_runner.ts` 不存在。

- [ ] **Step 4: 实现 Pi image 与 adapter**

`Dockerfile.pi-worker` 从已构建的 `coding-agent-worker:<repo-env>` 镜像开始（该镜像已含与 SWE-bench 环境匹配的 Linux Node），并通过 Docker BuildKit named context `pi=/Users/titusliu/Documents/ai-agent/pi` 复制 Pi 的 `package.json`、`package-lock.json`、`tsconfig*.json`、`packages/` 和 `pi-test.sh`；不复制 `.pi/`、`.git/` 或 `node_modules/`。随后在 Linux 内执行 `npm ci --ignore-scripts`。这避免把 macOS 的原生依赖和 Pi 私有 session/config 放入镜像。

`pi_runner.ts` 使用 `prepareTaskWorkspace`，构建固定 prompt 和 argv，使用 `DockerSandbox({ network: "bridge", passthroughEnvironment: ["DEEPSEEK_API_KEY"] })`。Pi stdout/stderr 分别保存为 `run/pi.jsonl`、`run/agent.log`，Pi session 保存在 `run/pi-session/`。`pi_task.ts` 负责严格解析单题 CLI 参数、调用 adapter、写 `run.json` 和 `metrics.json`，并在 Pi 非零退出时设置进程退出码。

- [ ] **Step 5: 新增 npm 脚本与文档命令**

```json
"eval:swebench:pi": "node --experimental-strip-types scripts/swebench/pi_task.ts"
```

文档需包含明确 build 命令、单题运行、官方 grading、产物路径，以及 `bridge` 网络差异。

- [ ] **Step 6: 运行 focused tests**

Run: `npm test -- tests/swebench/pi_runner.test.ts tests/swebench/docker_sandbox.test.ts`

Expected: PASS。

### Task 4: 批次 Runner 落盘统一指标并对 UI 暴露

**Files:**
- Modify: `scripts/swebench/batch_task.ts:12-235`
- Modify: `eval/ui/store.ts`
- Modify: `eval/ui/server.ts`（仅当已有响应类型需显式扩展）
- Modify: `eval/ui/public/app.js`
- Modify: `tests/swebench/batch_task.test.ts`
- Modify: `tests/eval/ui_store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TaskMetrics` 与 `summarizeMetrics`。
- Produces: `<task>/metrics.json`、`summary.json.metrics`，以及 UI task/run API 中的 `metrics`。

- [ ] **Step 1: 写失败测试：batch report 为每题写 metrics 并在 summary 保留聚合**

```ts
test("batch report 挂载 metrics 路径和批次聚合", () => {
  const summary = summarizeBatchResults([reportWithMetrics]);
  assert.equal(summary.metrics.resolvedCount, 1);
  assert.equal(reportWithMetrics.metrics.artifacts.agentLog, "run/agent.log");
});
```

- [ ] **Step 2: 写失败测试：UI 读取已有 metrics.json，旧运行缺少该文件时不报错**

```ts
test("store 对旧运行返回 null metrics，对新运行读取指标", async () => {
  assert.equal((await store.loadTask(oldTask)).metrics, null);
  assert.equal((await store.loadTask(newTask)).metrics.agent.id, "coding-agent");
});
```

- [ ] **Step 3: 运行失败测试**

Run: `npm test -- tests/swebench/batch_task.test.ts tests/eval/ui_store.test.ts`

Expected: FAIL，因为 `metrics` 尚未产生或 store 不读取该工件。

- [ ] **Step 4: 实现计时、指标落盘、汇总与 UI 最小展示**

`runOneTask` 在 workspace prepare/agent/grader/总运行边界以 `Date.now()` 记录毫秒。每题用 `writeFile` 在其 task root 落盘 `metrics.json` 后再触发 UI hook。旧 `summary.json` 的顶层 correctness 字段保留，新字段添加 `metrics`。

UI 只添加紧凑“指标”区域：Agent/model/profile、总耗时、tokens、tools、steps、compactions。没有 metrics 的旧运行显示“历史记录未采集”。

- [ ] **Step 5: 运行 focused tests**

Run: `npm test -- tests/swebench/batch_task.test.ts tests/eval/ui_store.test.ts`

Expected: PASS。

### Task 5: 历史回填、全量验证与一次真实 Pi 基线

**Files:**
- Create: `scripts/swebench/backfill_metrics.ts`
- Create: `tests/swebench/backfill_metrics.test.ts`
- Modify: `package.json`
- Modify: `scripts/swebench/README.md`

**Interfaces:**
- Consumes: 已存在的 `<run>/<task>/run/session.sqlite`、`run.json`、grade 结果。
- Produces: 对已有 Coding Agent baseline 的 `metrics.json`，其中不可精确重建的数据为 `null`，并有 `source: "historical-estimate"`。

- [ ] **Step 1: 写失败测试：回填不会把缺失阶段耗时伪装为零**

```ts
test("backfill 为旧 run 标记 historical-estimate", async () => {
  const metrics = await backfillTaskMetrics(taskPath);
  assert.equal(metrics.source, "historical-estimate");
  assert.equal(metrics.durationMs.workspacePrepare, null);
});
```

- [ ] **Step 2: 运行失败测试**

Run: `npm test -- tests/swebench/backfill_metrics.test.ts`

Expected: FAIL，因为回填器尚不存在。

- [ ] **Step 3: 实现最小回填器，并添加命令**

```json
"eval:swebench:backfill-metrics": "node --experimental-strip-types scripts/swebench/backfill_metrics.ts"
```

- [ ] **Step 4: 运行全量自动验证**

Run: `npm test && npm run typecheck`

Expected: 全部通过；真实模型不会被调用。

- [ ] **Step 5: 构建并运行一次真实 Pi baseline（仅在用户当前 shell 已导出 `DEEPSEEK_API_KEY` 后）**

```bash
docker buildx build --load \
  --build-context pi=/Users/titusliu/Documents/ai-agent/pi \
  -f coding-agent/eval/swebench/Dockerfile.pi-worker \
  --build-arg SWE_BENCH_BASE_IMAGE=<coding-agent-worker:same-env> \
  -t coding-agent-pi:sympy-env coding-agent
cd coding-agent
npm run eval:swebench:pi -- --tasks <same-task-file> --task-id <selected-task> ...
npm run eval:swebench:grade -- --tasks <same-task-file> --task-id <selected-task> ...
```

实际执行时不得在 shell 历史、命令输出或文件中写出 Key 值；应使用用户现有已导出的环境变量。若环境变量未导出，停止并报告，而不是读取 Pi 私有配置。

- [ ] **Step 6: 验收产物**

确认 Pi `metrics.json`、`run/pi.jsonl`、`run/pi-session/`、`grade/eval.log` 均可通过 UI 查看，并在最终报告列出相同/不同的比较条件。
