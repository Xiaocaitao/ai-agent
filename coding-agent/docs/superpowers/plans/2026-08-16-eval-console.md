# SWE-bench 评测控制台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一个本地 Web 控制台，一键启动现有 SWE-bench 批量评测，实时查看过程和历史结果，并通过当前 provider 流式生成 Markdown 分析。

**Architecture:** Node 原生 `http` 服务托管静态单页并提供 JSON/SSE API；评测服务直接调用现有 `runBatch`，每次 run 使用独立结果/workspace 子目录；结果读取层只读 `summary.json`、`session.sqlite` 和 grader/Agent 日志，分析层在服务端复用当前 provider。

**Tech Stack:** Node 22 `node:http`、`node:sqlite`、TypeScript strip-types、原生 HTML/CSS/JavaScript、SSE。

## Global Constraints

- API key 只能在 Node 服务端；不得返回浏览器或传给 Worker。
- 评测使用现有 Docker Worker/Grader；不实现评测会话恢复。
- 所有用户路径必须是绝对路径；taskId/runId 必须阻止路径穿越。
- 不新增前端框架依赖；不自动提交 git。
- 日志和 Markdown 必须先转义/安全渲染。

---

### Task 1: 批量评测事件接口

**Files:**
- Modify: `scripts/swebench/batch_task.ts`
- Test: `tests/swebench/batch_task.test.ts`

**Interfaces:**
- Produces optional `BatchRunHooks` with `onTaskStart`, `onTaskComplete`, `onLog`, `onRunError` callbacks while preserving the CLI behavior.

- [ ] **Step 1: Add failing hook test** — invoke `runBatch` with injected task runner seams or test the hook type/forwarding without Docker.
- [ ] **Step 2: Implement hook forwarding and incremental events** — emit task start/grade and completion events, leaving existing summary JSON unchanged.
- [ ] **Step 3: Run `node --experimental-strip-types --test tests/swebench/batch_task.test.ts` and `npm run typecheck`.

### Task 2: 评测数据读取与 API 服务

**Files:**
- Create: `eval/ui/store.ts`
- Create: `eval/ui/server.ts`
- Test: `tests/eval/ui_store.test.ts`
- Modify: `package.json`

**Interfaces:**
- `createEvalServer(options): http.Server`.
- `EvaluationStore.listRuns(resultsRoot)`, `getRun(resultsRoot, runId)`, `getTaskSession(...)`, `getTaskLog(...)`.
- API requests/responses as defined in the design spec.

- [ ] **Step 1: Write tests for path validation, listing run metadata, summary loading and SQLite message extraction.**
- [ ] **Step 2: Implement read-only store with bounded text output and safe run/task IDs.**
- [ ] **Step 3: Implement HTTP JSON routes and static file serving.**
- [ ] **Step 4: Add `eval:ui` script and run focused tests/typecheck.**

### Task 3: 评测启动、SSE 进度与健康检查

**Files:**
- Modify: `eval/ui/server.ts`
- Modify: `eval/ui/store.ts`
- Test: `tests/eval/ui_server.test.ts`

**Interfaces:**
- `POST /api/evaluations` returns `{runId, resultsRoot, status}`.
- `GET /api/evaluations/:runId/events` emits `task_start`, `log`, `task_complete`, `run_complete`, `run_error`.
- `GET /api/health` exposes provider model and preflight status without credentials.

- [ ] **Step 1: Add tests for start validation, SSE headers/events and secret redaction.**
- [ ] **Step 2: Implement in-memory run registry and `run.json` metadata.**
- [ ] **Step 3: Start `runBatch` asynchronously with unique run/workspace roots and publish hooks to SSE clients.**
- [ ] **Step 4: Run focused API tests and full unit suite.**

### Task 4: 流式 AI 分析 API

**Files:**
- Modify: `eval/ui/server.ts`
- Test: `tests/eval/ui_analysis.test.ts`

**Interfaces:**
- `POST /api/evaluations/:runId/analyze` returns `text/event-stream` with `delta`, `done`, or `error` events.
- Analysis prompt receives only structured metrics, failure names, and bounded logs/trace metadata; provider credentials remain server-side.

- [ ] **Step 1: Test SSE framing, provider stream forwarding and prompt redaction with a fake client.**
- [ ] **Step 2: Implement provider Responses streaming via current runtime provider configuration.**
- [ ] **Step 3: Run focused analysis tests and typecheck.**

### Task 5: 控制台 UI

**Files:**
- Create: `eval/ui/public/index.html`
- Create: `eval/ui/public/styles.css`
- Create: `eval/ui/public/app.js`
- Modify: `eval/ui/server.ts`
- Modify: `scripts/swebench/README.md`

**Interfaces:**
- Browser consumes the API/SSE routes without exposing provider secrets.

- [ ] **Step 1: Build form, run progress, history, task detail and analysis panels.**
- [ ] **Step 2: Add responsive dark visual system and accessible status/empty/error states.**
- [ ] **Step 3: Add safe Markdown renderer for streamed analysis and escaped log/trace views.**
- [ ] **Step 4: Document `npm run eval:ui` and hand-run against an existing result directory.**

### Task 6: Final verification

**Files:**
- Modify: `scripts/swebench/README.md` if verification notes need adjustment.

- [ ] **Step 1: Run `npm run typecheck`.**
- [ ] **Step 2: Run `npm test`.**
- [ ] **Step 3: Start the UI and verify a read-only historical run, a new run, live SSE logs and streaming analysis manually.**
