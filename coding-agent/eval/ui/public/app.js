import { aggregateBehavior } from "./behavior_metrics.js";

(() => {
  const $ = (id) => document.getElementById(id);
  const LEGACY_RESULTS_ROOT = "/tmp/swebench-results";
  const DEFAULT_RESULTS_ROOT = LEGACY_RESULTS_ROOT;
  const state = { resultsRoot: localStorage.getItem("eval.resultsRoot") || DEFAULT_RESULTS_ROOT, runs: [], activeRun: null, selectedTask: null, taskTab: "session" };
  const fields = ["tasks", "repoRoot", "workspaces", "results", "image", "python", "maxSteps"];

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;", "'":"&#39;"}[char]));
  const pct = (value) => `${(Number(value || 0) * 100).toFixed(1)}%`;
  const fmtTokens = (value) => { const n = Number(value || 0); return n ? n.toLocaleString() : "--"; };
  const formatMarkdown = (input) => {
    let text = esc(input);
    const blocks = [];
    text = text.replace(/```([\s\S]*?)```/g, (_, code) => { blocks.push(`<pre><code>${code.trim()}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
    text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>").replace(/^## (.+)$/gm, "<h2>$1</h2>").replace(/^# (.+)$/gm, "<h1>$1</h1>");
    text = text.replace(/^[-*] (.+)$/gm, "<li>$1</li>").replace(/(<li>[\s\S]*?<\/li>)(?:\n|$)/g, "$1");
    text = text.replace(/(<li>.*<\/li>\n?)+/g, (list) => `<ul>${list}</ul>`).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
    text = text.split(/\n\n+/).map((part) => /<h\d|<ul>|\u0000\d+\u0000/.test(part.trim()) ? part : `<p>${part.replace(/\n/g, "<br>")}</p>`).join("");
    return text.replace(/\u0000(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
  };
  const setView = (view) => { document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}-view`)); document.querySelectorAll(".nav-item").forEach((node) => node.classList.toggle("active", node.dataset.view === view)); $("page-title").textContent = view === "history" ? "历史评测" : view === "detail" ? "评测详情" : "评测总览"; };
  const saveForm = () => fields.forEach((name) => localStorage.setItem(`eval.${name}`, $(name).value));
  const loadForm = () => fields.forEach((name) => { const value = localStorage.getItem(`eval.${name}`); if (value && $(name)) $(name).value = value; });
  const syncResultsRoot = () => { state.resultsRoot = $("results").value.trim(); if (state.resultsRoot) { localStorage.setItem("eval.results", state.resultsRoot); localStorage.setItem("eval.resultsRoot", state.resultsRoot); } };
  const summaryOf = (run) => run.summary || {};
  const duration = (milliseconds) => typeof milliseconds === "number" ? milliseconds >= 60000 ? `${(milliseconds / 60000).toFixed(1)} min` : `${(milliseconds / 1000).toFixed(1)} s` : "--";
  const tokens = (value) => typeof value === "number" ? value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value) : "--";
  const renderMetrics = (root, summary) => { const metrics = summary.metrics || {}; const values = [pct(summary.resolvedRate), pct(summary.averageFailToPass), pct(summary.averagePassToPass), summary.taskCount ?? "--", tokens(metrics.totalTokens), duration(metrics.totalDurationMs)]; root.innerHTML = values.map((value, index) => `<div class="metric"><span>${["Resolved rate","FAIL → PASS","PASS → PASS","Tasks","Tokens","Duration"][index]}</span><strong>${value}</strong><small>${["完全解决率","平均通过率","平均通过率","本轮任务数","总模型消耗","总运行时长"][index]}</small></div>`).join(""); };
  const renderBehavior = (tasks) => {
    const panel = $("behavior-panel");
    const hasMetrics = tasks.some((item) => item?.metrics?.agentBehavior);
    panel.classList.toggle("hidden", !hasMetrics);
    if (!hasMetrics) return;
    const behavior = aggregateBehavior(tasks);
    const cards = [
      ["Steps", behavior.steps, "模型步骤"],
      ["Requests", behavior.modelRequests, "模型请求"],
      ["Tools", behavior.toolCalls, "工具调用"],
      ["Tool errors", behavior.toolFailures, "工具失败"],
      ["Verification", behavior.verificationCommands, "验证命令"],
      ["Compactions", behavior.contextCompactions, "上下文压缩"],
      ["Agent time", duration(behavior.agentDurationMs), "Agent 执行耗时"],
    ];
    $("behavior-metrics").innerHTML = cards.map(([label, value, note]) => `<div class="metric"><span>${label}</span><strong>${value ?? "--"}</strong><small>${note}</small></div>`).join("");
    const tools = Object.entries(behavior.toolCallsByName).sort(([, left], [, right]) => right - left);
    $("behavior-tools").innerHTML = tools.length
      ? `<div class="eyebrow">TOOL DISTRIBUTION</div><div class="tool-tags">${tools.map(([name, count]) => `<span class="tool-tag"><code>${esc(name)}</code><strong>${count}</strong></span>`).join("")}</div>`
      : `<span class="muted">暂无工具分布数据</span>`;
  };
  const runRow = (run) => { const s = summaryOf(run); return `<div class="run-row" data-run="${esc(run.runId)}"><div><div class="run-id">${esc(run.runId)}</div><div class="run-date">${esc(run.createdAt || "")}</div></div><div><div class="row-value">${pct(s.resolvedRate)}</div><div class="run-date">resolved</div></div><div><div class="row-value">${pct(s.averageFailToPass)}</div><div class="run-date">F → P</div></div><div><div class="row-value">${s.taskCount ?? "--"}</div><div class="run-date">tasks</div></div><div class="run-status ${esc(run.status)}">${run.status === "completed" ? "完成" : run.status === "running" ? "运行中" : "失败"}</div></div>`; };
  const renderRuns = () => { const html = state.runs.length ? state.runs.map(runRow).join("") : `<div class="empty-state"><span class="empty-icon">◌</span><strong>暂无历史评测</strong><span>完成一次评测后，记录会出现在这里</span></div>`; $("recent-list").innerHTML = html; $("history-list").innerHTML = html; document.querySelectorAll(".run-row").forEach((row) => row.addEventListener("click", () => openRun(row.dataset.run))); };
  const fetchRuns = async () => { if (!state.resultsRoot) { state.runs = []; renderRuns(); return; } try { const response = await fetch(`/api/evaluations?resultsRoot=${encodeURIComponent(state.resultsRoot)}`); const data = await response.json(); if (!response.ok) throw new Error(data.error); state.runs = data.runs || []; renderRuns(); } catch (error) { $("form-status").textContent = error.message; } };
  const openRun = async (runId) => { const response = await fetch(`/api/evaluations/${encodeURIComponent(runId)}?resultsRoot=${encodeURIComponent(state.resultsRoot)}`); const run = await response.json(); if (!response.ok) return alert(run.error); state.activeRun = run; renderDetail(run); setView("detail"); };
  const renderDetail = (run) => {
    $("detail-run-id").textContent = run.runId;
    $("detail-created").textContent = `${run.status} · ${run.createdAt || ""}`;
    renderMetrics($("detail-metrics"), summaryOf(run));
    const tasks = Array.isArray(summaryOf(run).tasks) ? summaryOf(run).tasks : [];
    renderBehavior(tasks);
    $("detail-task-count").textContent = `${tasks.length} tasks`;
    $("task-list").innerHTML = tasks.length ? tasks.map((item) => {
      const grade = item.grade || {};
      const c = grade.correctness || {};
      const m = item.metrics || {};
      const behavior = m.agentBehavior || {};
      const behaviorLine = [
        `${behavior.steps ?? "--"} steps`,
        `${behavior.modelRequests ?? "--"} req`,
        `${behavior.toolFailures ?? "--"} errors`,
        `${behavior.verificationCommands ?? "--"} verify`,
        `${behavior.contextCompactions ?? "--"} compact`,
      ].join(" · ");
      return `<div class="task-card" data-task="${esc(item.taskId)}"><strong>${esc(item.taskId)}</strong><div class="task-meta"><span class="${grade.resolved ? "pass" : "fail"}">${grade.resolved ? "RESOLVED" : "UNRESOLVED"}</span><span>F→P ${pct(c.failToPass)}</span><span>P→P ${pct(c.passToPass)}</span><span>${esc(m.agent?.id || "legacy")} · ${tokens(behavior.totalTokens)} · ${behavior.toolCalls ?? "--"} tools · ${duration(m.durationMs?.total ?? m.durationMs?.agent ?? behavior.sessionDurationMs)}</span></div><div class="behavior-line">${esc(behaviorLine)}</div></div>`;
    }).join("") : `<div class="empty-state"><span>任务结果尚未落盘</span></div>`;
    document.querySelectorAll(".task-card").forEach((node) => node.addEventListener("click", () => openTask(node.dataset.task)));
    $("analysis-output").innerHTML = "点击右上角「总分析 / 改进报告」，汇总当前 run 的失败模式。";
    $("analysis-reasoning").textContent = "";
    $("analysis-reasoning-panel").open = false;
    $("analysis-status").textContent = "READY";
    $("task-detail-panel").classList.add("hidden");
  };
  const openTask = async (taskId) => { state.selectedTask = taskId; $("task-detail-title").textContent = taskId; $("task-detail-panel").classList.remove("hidden"); $("task-analysis-output").textContent = "点击「分析此任务」，查看该题的失败根因和下一步验证建议。"; $("task-analysis-reasoning").textContent = ""; $("task-analysis-reasoning-panel").open = false; $("task-analysis-status").textContent = "READY"; await loadTaskTab(); };
  const loadTaskTab = async () => { if (!state.activeRun || !state.selectedTask) return; const url = state.taskTab === "session" ? `/api/evaluations/${encodeURIComponent(state.activeRun.runId)}/tasks/${encodeURIComponent(state.selectedTask)}/session?resultsRoot=${encodeURIComponent(state.resultsRoot)}` : `/api/evaluations/${encodeURIComponent(state.activeRun.runId)}/tasks/${encodeURIComponent(state.selectedTask)}/log?kind=${state.taskTab}&resultsRoot=${encodeURIComponent(state.resultsRoot)}`; const response = await fetch(url); const data = await response.json(); $("task-detail-content").textContent = response.ok ? (state.taskTab === "session" ? JSON.stringify(data, null, 2) : data.text) : data.error; };
  const consumeSse = async (response, onEvent) => { const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); const chunks = buffer.split("\n\n"); buffer = chunks.pop(); for (const chunk of chunks) { const data = chunk.split("\n").find((line) => line.startsWith("data: ")); if (!data) continue; try { onEvent(JSON.parse(data.slice(6))); } catch {} } } };
  const connectEvents = (runId) => { const source = new EventSource(`/api/evaluations/${encodeURIComponent(runId)}/events`); let completed = 0; let total = 0; source.onmessage = () => {}; ["run_start","task_start","log","task_complete","run_complete","run_error"].forEach((name) => source.addEventListener(name, (event) => { const data = JSON.parse(event.data); if (name === "log") { const log = $("live-log"); log.textContent += `${data.line}\n`; log.scrollTop = log.scrollHeight; } if (name === "task_start") { total = Number(data.total || total); $("live-phase").textContent = `${data.taskId} · ${data.phase}`; $("progress-label").textContent = `${completed} / ${total || "?"} tasks`; } if (name === "task_complete") { completed += 1; const width = total ? Math.round(completed / total * 100) : 0; $("progress-bar").style.width = `${width}%`; $("progress-label").textContent = `${completed} / ${total || "?"} tasks`; } if (name === "run_complete" || name === "run_error") { source.close(); $("progress-bar").style.width = name === "run_complete" ? "100%" : `${total ? Math.round(completed / total * 100) : 0}%`; $("live-badge").textContent = name === "run_complete" ? "DONE" : "ERROR"; $("live-empty").classList.remove("hidden"); $("live-content").classList.add("hidden"); state.resultsRoot = data.resultsRoot || state.resultsRoot; fetchRuns(); if (name === "run_complete") renderMetrics($("metrics"), data.summary); } })); source.onerror = () => { if (source.readyState === EventSource.CLOSED) source.close(); }; };
  const startRun = async (event) => { event.preventDefault(); syncResultsRoot(); saveForm(); $("start-btn").disabled = true; $("form-status").textContent = "正在创建评测…"; const body = Object.fromEntries(fields.map((name) => [name, $(name).value])); try { const response = await fetch("/api/evaluations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); $("live-empty").classList.add("hidden"); $("live-content").classList.remove("hidden"); $("live-run-id").textContent = data.runId; $("live-log").textContent = ""; $("live-badge").textContent = "RUNNING"; $("progress-label").textContent = "0 / ? tasks"; connectEvents(data.runId); $("form-status").textContent = `运行 ${data.runId}`; fetchRuns(); } catch (error) { $("form-status").textContent = error.message; } finally { $("start-btn").disabled = false; } };
  const analyze = async () => { if (!state.activeRun) return; $("analyze-btn").disabled = true; $("analysis-status").textContent = "STREAMING"; $("analysis-output").innerHTML = ""; $("analysis-reasoning").textContent = ""; $("analysis-reasoning-panel").open = true; let text = ""; let failed = false; try { const response = await fetch(`/api/evaluations/${encodeURIComponent(state.activeRun.runId)}/analyze?resultsRoot=${encodeURIComponent(state.resultsRoot)}`, { method: "POST" }); await consumeSse(response, (event) => { if (event.type === "reasoning_delta") { $("analysis-reasoning").textContent += event.text; } if (event.type === "delta") { text += event.text; $("analysis-output").innerHTML = formatMarkdown(text); } if (event.type === "error") { failed = true; $("analysis-output").textContent = event.error; } }); $("analysis-status").textContent = failed ? "ERROR" : "DONE"; } catch (error) { $("analysis-output").textContent = error.message; $("analysis-status").textContent = "ERROR"; } finally { $("analyze-btn").disabled = false; } };
  const analyzeTask = async () => { if (!state.activeRun || !state.selectedTask) return; $("task-analyze-btn").disabled = true; $("task-analysis-status").textContent = "STREAMING"; $("task-analysis-output").innerHTML = ""; $("task-analysis-reasoning").textContent = ""; $("task-analysis-reasoning-panel").open = true; let text = ""; let failed = false; try { const response = await fetch(`/api/evaluations/${encodeURIComponent(state.activeRun.runId)}/tasks/${encodeURIComponent(state.selectedTask)}/analyze?resultsRoot=${encodeURIComponent(state.resultsRoot)}`, { method: "POST" }); await consumeSse(response, (event) => { if (event.type === "reasoning_delta") { $("task-analysis-reasoning").textContent += event.text; } if (event.type === "delta") { text += event.text; $("task-analysis-output").innerHTML = formatMarkdown(text); } if (event.type === "error") { failed = true; $("task-analysis-output").textContent = event.error; } }); $("task-analysis-status").textContent = failed ? "ERROR" : "DONE"; } catch (error) { $("task-analysis-output").textContent = error.message; $("task-analysis-status").textContent = "ERROR"; } finally { $("task-analyze-btn").disabled = false; } };
  const health = async () => { try { const data = await (await fetch("/api/health")).json(); $("health-dot").style.color = "var(--accent)"; $("health-dot").style.background = "var(--accent)"; $("health-text").textContent = `${data.provider.model} · ready`; $("provider-pill").textContent = `Provider · ${data.provider.model}`; if ($("results").value.trim() === LEGACY_RESULTS_ROOT && typeof data.defaultResultsRoot === "string") { $("results").value = data.defaultResultsRoot; syncResultsRoot(); fetchRuns(); } } catch { $("health-text").textContent = "服务未就绪"; } };
  document.querySelectorAll("[data-view]").forEach((node) => node.addEventListener("click", () => setView(node.dataset.view)));
  $("run-form").addEventListener("submit", startRun); $("refresh-btn").addEventListener("click", () => { syncResultsRoot(); health(); fetchRuns(); }); $("results").addEventListener("change", () => { syncResultsRoot(); fetchRuns(); }); $("back-btn").addEventListener("click", () => setView("dashboard")); $("analyze-btn").addEventListener("click", analyze); $("task-analyze-btn").addEventListener("click", analyzeTask); $("close-task").addEventListener("click", () => $("task-detail-panel").classList.add("hidden")); document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { document.querySelectorAll(".tab").forEach((node) => node.classList.remove("active")); tab.classList.add("active"); state.taskTab = tab.dataset.tab; loadTaskTab(); }));
  loadForm(); if (!$("results").value) $("results").value = state.resultsRoot; state.resultsRoot = $("results").value || state.resultsRoot; health(); fetchRuns();
})();
