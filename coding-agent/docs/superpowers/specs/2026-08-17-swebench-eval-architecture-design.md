# SWE-bench 评测架构学习页设计

## 目标

在 `docs/swebench-eval-architecture.html` 提供一份可双击打开的中文学习页，帮助不了解 Docker 和评测系统的读者理解当前 Coding Agent 如何完成一次 SWE-bench 评测。

## 范围

- 只展示评测后台链路，不展示 Eval Lab 前端页面或操作界面。
- 解释任务清单、宿主机调度器、Worker 容器、宿主机模型代理、Grader 容器、持久化结果目录之间的数据流。
- 用点击节点的方式展示每个部件的职责、输入、输出与安全边界。
- 单独解释 Docker 的镜像、容器、bind mount、网络隔离、容器销毁和结果持久化。
- 列出 Agent 可见和不可见的数据：公开 `problem_statement` 可见；gold patch 与隐藏测试不可见；模型密钥只留在宿主机。

## 不做什么

- 不运行评测、不调用模型、不读取本地结果文件。
- 不依赖服务端、CDN 或构建步骤。
- 不修改现有评测执行、Docker、评分或前端代码。

## 页面结构

1. 顶部只显示一次评测的六个核心节点：任务清单、宿主机调度器、Worker 容器、模型代理、Grader 容器、结果目录；只保留五条关键数据流，避免首次打开信息过载。
2. 顶层用宿主机、Worker Docker、Grader Docker 三个边界框表达运行位置，但不显示具体文件路径、命令、测试指标或协议细节。
3. 点击核心节点后，右侧详情区域再展示它的职责、输入、输出和对应的白话解释；点击“查看细节”后才展开 bind mount、stdin/stdout、SQLite、diff、测试集与评分指标。
4. 下方以可逐步展开的时间线列出单题生命周期；安全边界区按“Agent 可见”“Agent 不可见”“宿主机保留”三项分层展示网络、密钥、gold patch、隐藏测试与文件挂载限制。
5. Docker 入门区用“镜像 vs 容器”“bind mount”“容器网络”三个短卡片解释本项目实际用法，并由概念卡片链接到相应流程细节。

## 真实性约束

- Worker 在 Docker 内运行当前 `ReActAgent`，其 `run_command` 由容器命令执行器执行。
- 任务工作区与结果目录通过 bind mount 映射进 Worker；Worker 默认关闭网络。
- Worker 通过标准输入/输出向宿主机模型代理请求模型；Provider 与 API key 不传入容器。
- Grader 在独立容器中使用相同 task workspace 和 SWE-bench 测试规则评分，并产出 `FAIL_TO_PASS`、`PASS_TO_PASS`、`resolved` 等结果。
- Agent 过程保存为 `run/session.sqlite`、`run/agent.log`；评分过程保存为 `grade/eval.log`；批次汇总为 `summary.json`。

## 技术约束

- 一个文件：原生 HTML、CSS、内嵌 SVG 与少量原生 JavaScript。
- 不引用外部资源；离线双击打开可用。
- 视觉内容使用中文、术语首次出现时附白话解释。
- 页面适配常见桌面窗口，也可在窄屏纵向阅读。
