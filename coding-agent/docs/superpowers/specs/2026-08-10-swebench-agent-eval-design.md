# SWE-bench Coding Agent 评估设计

## 目标

把当前项目的评估目标从人工 fixture bug 修复切换为真实开源项目问题解决。被测对象是当前 Coding Agent Harness 与固定模型的组合；SWE-bench 只提供真实任务、可复现环境和客观测试判定。

第一阶段固定 20 个任务，按 16 个 development task 和 4 个 holdout task 分组。development 集用于 Harness 迭代，holdout 集只用于回归确认，避免只针对开发集过拟合。

## 范围

纳入：

- Agent 对真实 Issue 的理解和执行
- 仓库导航、任务拆分、工具选择和文件修改
- 测试运行、失败分析和继续修复
- 长程执行、上下文管理和错误恢复
- 安全边界、命令行为和修改范围
- Token、模型请求数、工具调用数、耗时和稳定性

不纳入：

- 用户澄清、审批和中途改变需求
- 当前项目人工 fixture 作为主评测集
- 直接复用其他 Agent 生成的 patch 作为本 Agent 结果

## 任务数据

每个 SWE-bench task 固定保存以下元数据：

```text
task_id
repo
base_commit
problem_statement
FAIL_TO_PASS
PASS_TO_PASS
language
version
difficulty
capability_tags
dataset_revision
```

第一版选择原则：5 个 easy、10 个 medium、5 个 hard；至少覆盖 5 个仓库，单个仓库最多 4 个任务。任务 ID、数据集版本和选择结果必须提交到仓库，保证每次 Harness 迭代使用同一批任务。

## 运行架构

```text
宿主机
  Agent Worker + 模型 API 客户端 + 文件工具
       │
       ├── 文件读写：临时 workspace，应用层路径校验
       └── run_command：DockerSandbox 后端
                         │
                         └── 单 task Docker 容器
                               仓库、依赖、测试和工作目录
```

Agent 仍然是被测对象。Docker 不运行另一个 Agent，只提供 SWE-bench 的项目依赖、测试环境和隔离边界。模型 API 请求由宿主机发起；任务容器不接收 API Key，不挂载 Docker socket，不挂载宿主机项目根目录。

现有 macOS Seatbelt 后端不删除，但不作为 SWE-bench 主路径。命令执行抽象为可替换的 sandbox backend：本地旧流程使用 macOS Seatbelt，SWE-bench 使用 DockerSandbox。

## 单任务流程

1. 从固定数据集加载 task。
2. 准备对应的 SWE-bench Docker image/container，并 checkout `base_commit` 基线commit。
3. 建立只包含该 task workspace 的显式 bind mount 挂载。
4. 把 `problem_statement` 传给当前 Agent，不暴露 gold patch （官方最终修复方案）或隐藏测试。
5. Agent 使用现有 ReAct、上下文管理和工具权限完成修改。
6. `read_file`、`search_files`、`edit_file`、`write_file` 只允许访问 task workspace；`run_command` 在 Docker 容器内执行。
7. Agent 结束、超时或异常后收集 git diff、工具轨迹和资源指标。
8. 在同一个固定环境中运行 `FAIL_TO_PASS` 和 `PASS_TO_PASS` 测试。
9. 生成任务级结果，并清理容器；报告保留可复查的 task workspace 或 patch 摘要，不保留密钥和完整敏感输出。

## 评分

### SWE-bench 结果

`resolved` 只有在所有 `FAIL_TO_PASS` 通过且 `PASS_TO_PASS` 没有回归时才为真。

### Harness 诊断维度

结果不压缩为单一 pass/fail，至少保留：

- `correctness` 是否修好
- `instruction_following` 是否遵守要求
- `repository_navigation` 是否找对代码位置
- `tool_use` 工具使用是否合理
- `verification` 是否跑验证
- `long_horizon` 长任务是否可持续干活
- `recovery` 出错后是否能恢复
- `safety` 是否遵守安全边界
- `scope_changes` 修改范围是否合理
- `token_usage` token消耗
- `duration` 完成任务用了多久

文件修改范围作为诊断指标，不使用 gold patch 的文件列表作为唯一允许列表；真实任务可能存在多个正确实现。安全越界、测试篡改和宿主机写入仍然是独立失败条件。

## 报告与迭代

每次运行固定记录：

- Agent 版本 commit
- 模型和模型配置摘要
- SWE-bench 数据集版本和 20 个 task ID
- development / holdout 通过率
- 按难度和能力标签的通过率
- 每题失败阶段和失败原因
- Token、请求数、工具调用数和耗时

两次 Harness 运行只有在模型、任务集合、容器版本和主要配置一致时才允许直接比较。每次修改 Agent 后先跑 development 子集，再跑完整 20 题和 holdout 子集。

## 分阶段交付

1. 验证 Docker 和一个官方 gold task。
2. 固定并提交 20 个 task 元数据。
3. 实现 DockerSandbox 和单 task Agent 运行。
4. 实现 SWE-bench 测试评分与报告。
5. 扩展到 16 个 development + 4 个 holdout。
6. 增加版本对比和失败反馈摘要，为后续 Git 提交闭环提供输入。

## 非目标

- 第一阶段不做自动 `git commit`/`pre-push` 触发。
- 第一阶段不做多 Agent 协作。
- 第一阶段不追求 SWE-bench 全量 500 题排行榜成绩。
- 第一阶段不移除旧的本地 fixture 文件，只停止其作为主入口。
