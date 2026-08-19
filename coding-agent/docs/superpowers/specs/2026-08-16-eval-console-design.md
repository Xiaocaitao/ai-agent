# SWE-bench 本地评测控制台设计

## 目标

提供一个只在本机运行的 Web 控制台，用于一键启动现有 SWE-bench 批量评测、查看运行进度和历史结果，并使用当前 `config/settings.toml` 的 provider 流式生成 Markdown 格式的失败分析。

## 范围

- 支持配置 task JSON、仓库缓存、workspace 根目录、结果根目录、Worker 镜像、SWE-bench Python 和最大步数。
- 评测仍复用 `runBatch`、Worker Docker 和官方 Grader Docker，不改变评测隔离边界。
- `session.sqlite`、Agent 输出和 `eval.log` 只读展示，不支持从评测会话恢复或续跑。
- API key 只存在 Node 服务端，不进入浏览器响应或 Docker Worker 环境变量。
- 浏览器通过 SSE 接收评测事件和 AI 分析增量；分析结果按 Markdown 预览。

## 架构

```text
浏览器静态页面
  -> eval/ui/server.ts (localhost HTTP API)
     -> batch_task.runBatch (Docker Worker + Grader)
     -> run/session.sqlite、grade/eval.log、summary.json
     -> 当前 provider 的 Responses API (AI 分析 SSE)
```

服务端保存内存中的活动 run 事件，同时把每次 run 的 `run.json` 写入结果目录，历史页面通过该元数据和 `summary.json` 读取已完成 run。服务重启后仍可读取历史结果，但运行中的 SSE 连接不会跨进程恢复。

## API

- `GET /`：返回控制台静态页面。
- `GET /api/health`：返回 provider、SWE-bench 和 Docker 预检状态，不返回密钥。
- `POST /api/evaluations`：校验绝对路径和参数，创建 runId，在独立的 `<resultsRoot>/<runId>` 与 `<workspacesRoot>/<runId>` 下调用 `runBatch`。
- `GET /api/evaluations?resultsRoot=<path>`：列出结果根目录下的历史 run。
- `GET /api/evaluations/:runId?resultsRoot=<path>`：返回 run 元数据、summary 和每题摘要。
- `GET /api/evaluations/:runId/events`：SSE 推送 task 开始、日志、task 完成、run 完成或失败。
- `GET /api/evaluations/:runId/tasks/:taskId/session`：读取并裁剪该题 `session.sqlite` 中的消息记录。
- `GET /api/evaluations/:runId/tasks/:taskId/log?kind=agent|grader`：读取裁剪后的 Agent 或官方 grader 日志。
- `POST /api/evaluations/:runId/analyze`：将结构化结果和失败日志摘要交给当前 provider，SSE 流式返回 Markdown。

## 前端

单页控制台使用原生 HTML/CSS/JavaScript，避免新增框架依赖。界面包括：运行表单、运行进度、历史列表、指标卡片、任务详情抽屉、轨迹/日志查看器和 AI 分析 Markdown 预览。日志和模型输出按文本转义后渲染，Markdown 只支持安全的标题、列表、粗体、行内代码和代码块。

## 错误处理

- 参数缺失、相对路径、目录不可写、未知 run/task 返回 4xx。
- Docker、SWE-bench 或 Agent 失败记录为 run/task error，并继续保留已完成任务结果。
- SSE 客户端断开不取消评测；评测完成后结果仍落盘。
- AI 分析失败通过 SSE `error` 事件返回，不影响原始评测结果。

## 验证

- API 参数、runId/path 安全、历史读取、SSE 事件和 Markdown 转义单测。
- `npm run typecheck`。
- `npm test`。
- 手工启动 `npm run eval:ui`，浏览器打开 `http://127.0.0.1:3210`，用已有单 task JSON 验证启动、实时日志、grade 结果和流式分析。
