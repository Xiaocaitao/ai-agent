# SWE-bench Agent Eval Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先在本机用 Docker 验证一个固定的 SWE-bench 真实任务，再把当前 Coding Agent 接入同一任务环境，为后续 20 题回归集建立可复现基础。

**Architecture:** 宿主机只运行 Orchestrator、容器生命周期管理和模型 API 代理；每个 SWE-bench task 使用独立 Docker Worker 容器承载当前 Agent、仓库、依赖和测试。Agent 的文件工具与 `run_command` 全部在 Worker 容器内执行，宿主机不承载 task workspace。先完成单任务闭环，再扩展任务选择、报告和 holdout。

**Tech Stack:** TypeScript/Node.js 现有 Runtime、Docker CLI/Engine、Python `swebench` 官方 Harness、SWE-bench 固定 task metadata、Node test runner。

## Global Constraints

- 评估主体是当前 Coding Agent + 固定模型；Docker Worker 同时提供 Agent 运行环境、真实项目依赖、测试和隔离。
- 第一阶段只验证一个 task；20 题选择和完整报告放到后续任务。
- Docker Worker 只挂载当前 task 的 workspace 和显式结果输出目录，不挂载项目根目录、用户主目录、Docker socket 或密钥目录。
- Agent 只接收 `problem_statement`，不接收 gold patch、隐藏测试或参考提交。
- 宿主机 API Key 不写入 task 容器；模型请求通过宿主机 API 代理转发。除代理通道外，容器网络默认关闭。
- SWE-bench 使用 Docker Linux 环境；不得尝试安装或运行 macOS Docker image。
- 使用 Node `--experimental-strip-types` 运行 TypeScript；测试使用 `node --test`。
- 不删除旧本地 fixture Eval 文件；新入口稳定前不改变旧测试的默认语义。
- 每个任务、Docker 容器和临时目录必须有明确的 cleanup 路径；禁止递归删除用户目录或项目根目录。

---

### Task 1: 建立 SWE-bench 官方环境预检

**Files:**
- Create: `scripts/swebench/README.md`
- Create: `eval/swebench/preflight.ts`
- Create: `tests/swebench/preflight.test.ts`
- Modify: `package.json`

**Interfaces:**
- `preflight.ts` 接收 `--python <absolute-path>` 和 `--json`，检查 Python `swebench` 包和 Docker daemon；成功输出包含 `python`, `swebench_version`, `docker_server`, `architecture` 的 JSON。
- `package.json` 增加 `eval:swebench:preflight`，只调用预检，不调用模型、不修改仓库。

- [x] **Step 1: 写预检失败测试**

测试 `preflight.test.ts` 通过注入的 command runner 验证：Docker daemon 不可用时返回确定的 `docker_unavailable`；Python 包缺失时返回 `swebench_package_missing`；成功时返回结构化 metadata。

- [x] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test tests/swebench/preflight.test.ts`

Expected: FAIL，因为预检模块和 JSON 状态尚未定义。

- [x] **Step 3: 建立最小预检实现**

`preflight.ts` 只执行明确的只读检查：`<python> -c "import swebench; print(swebench.__version__)"`、`docker version --format {{.Server.Version}}` 和 `docker info --format {{.Architecture}}`；不得调用模型、启动长期容器或拉取隐藏测试。所有失败映射到固定状态和非零退出码。

- [x] **Step 4: 运行测试和本机预检**

Run: `node --experimental-strip-types --test tests/swebench/preflight.test.ts`

Run: `node --experimental-strip-types eval/swebench/preflight.ts --python /absolute/path/to/python --json`

Expected: 单元测试通过；本机输出 Docker server 版本、架构和 SWE-bench 包版本。若 Python 包或 Docker daemon 缺失，只报告缺失，不伪造成功。

- [x] **Step 5: 提交**

```bash
git add eval/swebench/preflight.ts package.json tests/swebench/preflight.test.ts scripts/swebench/README.md
git commit -m "feat: add SWE-bench environment preflight"
```

### Task 2: 固定一个 gold task 并验证官方评分环境

**Files:**
- Create: `scripts/swebench/gold_check.py`
- Create: `tests/swebench/gold_check.test.ts`
- Modify: `scripts/swebench/README.md`

**Interfaces:**
- `gold_check.py` 接收 `--instance-id <id>`、`--predictions-path gold` 和 `--run-id <id>`，调用官方 SWE-bench Harness 验证指定 gold patch；输出 `instance_id`, `fail_to_pass`, `pass_to_pass`, `resolved` 和日志目录。
- Gold check 只验证环境和评分器，不启动当前 Coding Agent。

- [ ] **Step 1: 写评分结果解析测试**

覆盖官方评分输出中 `resolved`, `FAIL_TO_PASS`, `PASS_TO_PASS` 的成功、失败和容器错误三种结构；解析失败必须返回 `grader_error`，不能误报 `resolved=true`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --experimental-strip-types --test tests/swebench/gold_check.test.ts`

Expected: FAIL，因为结果解析模块尚未实现。

- [ ] **Step 3: 实现官方 Harness 调用封装**

使用固定 `instance_id`、固定 `run_id` 和单 worker 调用官方 Harness。Apple Silicon 环境使用官方建议的本地镜像构建方式；日志路径必须是明确的项目外临时目录或 `eval/results/swebench/` 下的 run 目录。

- [ ] **Step 4: 运行一个 gold task**

Run: `python3 scripts/swebench/gold_check.py --instance-id sympy__sympy-20590 --predictions-path gold --run-id bootstrap-gold`

Expected: 官方 gold patch 在 Docker 环境中通过；如果 ARM 镜像、磁盘或依赖导致失败，记录第一处基础设施错误并停止，不进入 Agent 接入。

- [ ] **Step 5: 提交**

```bash
git add scripts/swebench tests/swebench/gold_check.test.ts
git commit -m "test: validate one SWE-bench gold task"
```

### Task 3: 为工具增加可替换命令执行后端

**Files:**
- Create: `tools/command_executor.ts`
- Modify: `tools/run_command.ts`
- Modify: `tools/index.ts`
- Create: `tests/tools/command_executor.test.ts`

**Interfaces:**
- `CommandExecutor`：`execute(args: string[], stdin: string | null, timeoutSeconds: number, cwd: string): Promise<CommandExecutionResult>`。
- 默认后端保持现有 macOS Seatbelt 行为。
- `configureCommandExecutor(executor)` 只影响当前 Worker 生命周期；`resetCommandExecutor()` 在测试和 task 清理时恢复默认后端。

- [ ] **Step 1: 写默认后端和替换后端测试**
- [ ] **Step 2: 运行 `node --experimental-strip-types --test tests/tools/command_executor.test.ts` 确认失败**
- [ ] **Step 3: 将 `run_command` 路由到当前 executor，保持既有参数校验、权限策略、输出截断和安全 metadata**
- [ ] **Step 4: 运行 `npm test -- tests/tools/command_executor.test.ts` 和既有 tools 测试**
- [ ] **Step 5: 提交 `feat: abstract command execution backend`**

### Task 4: 实现 Docker Worker 和单任务容器生命周期

**Files:**
- Create: `eval/swebench/docker_sandbox.ts`
- Create: `tests/swebench/docker_sandbox.test.ts`
- Modify: `eval/swebench/types.ts`

**Interfaces:**
- `DockerSandbox.start(task): Promise<{containerId: string; containerWorkspace: string; resultDirectory: string}>`
- `DockerSandbox.runWorker(input): Promise<WorkerResult>`
- `DockerSandbox.stop(): Promise<void>`
- 所有 Docker 命令通过 `runProcess` 执行，使用明确的 argv，不使用 shell 拼接；容器命令默认 `--network none`，只显式 bind mount task workspace 和结果目录。Worker 入口在容器内启动当前 Agent，文件工具和命令工具不再回到宿主机。

- [ ] **Step 1: 写容器参数和路径隔离测试**
- [ ] **Step 2: 运行 focused test 确认失败**
- [ ] **Step 3: 实现 start/runWorker/stop，使用固定 task workspace、超时和进程组终止；通过受控的宿主机模型代理转发请求**
- [ ] **Step 4: 运行 `docker run --rm` 级别集成测试，确认容器能读写 workspace、不能读取未挂载宿主路径、命令超时可清理**
- [ ] **Step 5: 提交 `feat: add Docker sandbox for SWE-bench tasks`**

### Task 5: 接入 Docker Worker 中的 Agent 单任务执行

**Files:**
- Create: `eval/swebench/task_loader.ts`
- Create: `eval/swebench/agent_runner.ts`
- Create: `eval/swebench/runner.ts`
- Create: `tests/swebench/agent_runner.test.ts`

**Interfaces:**
- `loadSWEbenchTask(path, id): Promise<SWEbenchTask>`
- `runSWEbenchTask(task, options): Promise<SWEbenchRunResult>`
- Agent 继续使用现有 `ReActAgent`、runtime prompt、模型配置和工具注册表；启动位置改为 Worker 容器内，task prompt 和模型请求代理配置由 Orchestrator 注入。

- [ ] **Step 1: 写 fake model/fake Docker 的 Agent runner 测试**
- [ ] **Step 2: 运行 focused test 确认失败**
- [ ] **Step 3: 实现 Worker 内 task prompt 注入、workspace 配置、工具轨迹和 Token 采集；确保宿主机只接收结构化结果**
- [ ] **Step 4: 用单个真实 task 运行当前 Agent，确认 Agent 修改的是 task workspace 而非主仓库**
- [ ] **Step 5: 提交 `feat: run coding agent on one SWE-bench task`**

### Task 6: 接入 FAIL_TO_PASS / PASS_TO_PASS 评分和报告

**Files:**
- Create: `eval/swebench/grader.ts`
- Create: `eval/swebench/report.ts`
- Create: `tests/swebench/grader.test.ts`
- Modify: `package.json`

**Interfaces:**
- `gradeSWEbenchTask(task, sandbox): Promise<SWEbenchGradeResult>`
- `buildSWEbenchReport(runs): SWEbenchReport`
- `npm run eval:swebench -- --instance-id <id>` 运行一个真实 Agent task；任何 infra error 返回非零退出码。

- [ ] **Step 1: 写测试结果解析和 resolved 规则测试**
- [ ] **Step 2: 运行 focused test 确认失败**
- [ ] **Step 3: 在同一 task 环境中运行两组测试，区分测试失败、超时和容器错误**
- [ ] **Step 4: 输出 JSON 报告，保留 correctness、verification、safety、scope、token_usage、duration 等字段**
- [ ] **Step 5: 运行单任务 end-to-end 并提交 `feat: grade SWE-bench agent task`**

### Task 7: 固定 20 题、development/holdout 和版本对比

**Files:**
- Create: `eval/swebench/selection.json`
- Create: `eval/swebench/compare.ts`
- Create: `tests/swebench/selection.test.ts`
- Modify: `package.json`
- Modify: `scripts/swebench/README.md`

**Interfaces:**
- `selection.json` 固定 20 个 task ID、16 个 dev、4 个 holdout、难度和能力标签。
- `npm run eval:swebench -- --subset dev|holdout|all`
- `npm run eval:swebench:compare -- --before <report> --after <report>`

- [ ] **Step 1: 写选择集完整性测试**
- [ ] **Step 2: 运行测试确认失败**
- [ ] **Step 3: 根据数据集版本提交固定 20 个 task selection**
- [ ] **Step 4: 实现按 subset、难度、能力标签汇总和前后版本对比**
- [ ] **Step 5: 运行 20 题回归、holdout、`npm test`、`npm run typecheck`，提交 `feat: add SWE-bench regression panel`**
