# SWE-bench 评测架构学习页 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一份可离线双击打开的中文 HTML，用逐层展开的流程图解释当前 SWE-bench 评测系统的数据流、Docker 边界和结果产物。

**Architecture:** 只创建 `docs/swebench-eval-architecture.html`，其中内嵌 CSS、SVG 和原生 JavaScript。顶部 SVG 展示 6 个核心节点与 5 条关键数据流；节点点击更新详情栏，详情栏中的开关才展示挂载、模型代理、SQLite 和评分等实现细节。

**Tech Stack:** 原生 HTML、CSS、SVG、JavaScript；无依赖、无网络请求、无构建步骤。

## Global Constraints

- 页面必须离线可用，不能引用 CDN、图片、字体或任何远程资源。
- 顶层仅显示任务清单、宿主机调度器、Worker 容器、模型代理、Grader 容器、结果目录和五条关键流向。
- 细节必须通过节点点击和“查看实现细节”展开，首次打开不能堆叠路径、命令或大量术语。
- 内容必须如实反映当前实现：Worker 内运行 ReActAgent；模型密钥不进入容器；Worker 默认无网络；Grader 独立运行；结果保存在宿主机挂载的目录。
- 不修改评测执行、Docker、评分、Provider 或 Eval Lab 前端；不自动提交 git。

---

### Task 1: 实现离线交互式学习页

**Files:**
- Create: `docs/swebench-eval-architecture.html`
- Reference: `docs/superpowers/specs/2026-08-17-swebench-eval-architecture-design.md`

**Interfaces:**
- Consumes: 当前评测架构事实与页面文案。
- Produces: 可双击打开的独立 HTML；`selectNode(nodeId)` 更新选中节点和右侧说明，`toggleDetails()` 显示或隐藏实现细节。

- [ ] **Step 1: 建立顶层流程图的静态验收骨架**

创建 SVG，固定渲染以下六个节点与五条边：

```text
任务清单 → 宿主机调度器 → Worker Docker → Grader Docker → 结果目录
                              ↕
                         宿主机模型代理
```

验收：图上不出现 `/testbed`、`session.sqlite`、stdin/stdout、gold patch、隐藏测试或具体命令。

- [ ] **Step 2: 添加节点详情与渐进展开交互**

为六个 SVG 节点添加 `data-node` 属性和点击处理：

```js
function selectNode(nodeId) {
  // 更新节点高亮、标题、职责、输入、输出和安全提示。
}

function toggleDetails() {
  // 切换 details 区块 hidden 状态，并同步按钮文案。
}
```

Worker 详情展开后必须包含：`/testbed` 工作区挂载、`/results` 产物挂载、`--network none`、标准输入/输出模型代理、`run/session.sqlite` 与 `run/agent.log`。Grader 详情展开后必须包含 `grade/eval.log`、FAIL_TO_PASS、PASS_TO_PASS 与 resolved。

- [ ] **Step 3: 添加 Docker 和安全边界学习区**

添加三个 Docker 概念卡：

```text
镜像：可复用的运行环境模板。
容器：一次任务期间实际启动的隔离进程环境。
bind mount：将宿主机指定目录映射进容器；容器删除后宿主机文件仍在。
```

添加三列安全边界：Agent 可见（公开问题、任务工作区）、Agent 不可见（gold patch、隐藏测试、API key）、宿主机保留（Provider 配置、结果目录、最终汇总）。

- [ ] **Step 4: 添加单题生命周期时间线**

按顺序展示：加载任务 → checkout/base commit 与工作区 → Worker 修改 → 收集 patch/trace/session → Grader 评分 → 汇总结果与清理容器。每一步最多两句白话解释，具体数据进入 Step 2 的详情区。

- [ ] **Step 5: 离线与交互验证**

运行：

```bash
node --check docs/swebench-eval-architecture.html
```

说明：若 `node --check` 不能直接校验 HTML，则将内嵌脚本提取到临时文件并用 `node --check` 校验；不修改交付文件。

在浏览器以本地文件方式打开，并验证：

```text
1. 首屏只见 6 节点、5 条关键边。
2. 点击 Worker，详情切换且默认不显示实现细节。
3. 点击“查看实现细节”，出现 Docker 挂载、无网络、模型代理、SQLite 日志。
4. 点击 Grader，显示评分三项与 grader 日志。
5. 在窄窗口下页面改为纵向布局，文本不截断。
```

- [ ] **Step 6: 检查交付范围**

运行：

```bash
git status --short -- docs/swebench-eval-architecture.html docs/superpowers/specs/2026-08-17-swebench-eval-architecture-design.md docs/superpowers/plans/2026-08-17-swebench-eval-architecture-html.md
```

验收：只出现学习页、设计说明和计划文档的未提交改动；不创建 commit。
