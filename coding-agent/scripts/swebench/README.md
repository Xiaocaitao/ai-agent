# SWE-bench 环境预检

预检只检查本机是否具备运行 SWE-bench 的 Python 包和 Docker daemon，不调用模型、不启动任务容器，也不读取或修改项目代码。

先创建独立 Python 环境并安装官方 Harness：

```bash
python3 -m venv /Users/titusliu/Documents/ai-agent/.swebench-venv
/Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python -m pip install --upgrade pip
/Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python -m pip install swebench==4.1.0
```

然后运行：

```bash
npm run eval:swebench:preflight -- \
  --python /Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python
```

成功时输出 Python 环境中的 SWE-bench 版本、Docker server 版本和 Docker 架构。失败时会返回稳定错误码，例如 `swebench_package_missing` 或 `docker_unavailable`。

Apple Silicon 上的 SWE-bench 镜像可能需要本地构建；正式运行前要确认 Docker 有足够的磁盘、内存和 CPU。

## 运行一个 Agent Worker task

先从数据集导出一个 task（下面示例只导出一个，不包含模型调用）：

```bash
/Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python -c '
import json
from datasets import load_dataset
ds = load_dataset("SWE-bench/SWE-bench_Lite", split="test")
task = next(x for x in ds if x["instance_id"] == "sympy__sympy-20590")
json.dump(task, open("/tmp/swebench-sympy-20590.json", "w"), ensure_ascii=False)
'
```

官方 env image 已经准备好后，构建带 Agent Worker 的镜像。SWE-bench 官方镜像通常是 `linux/amd64`；本机已有的本地镜像建议使用 legacy builder，避免 BuildKit 把本地 tag 当成远程镜像拉取：

```bash
DOCKER_BUILDKIT=0 docker build --pull=false --platform=linux/amd64 \
  --build-arg SWE_BENCH_BASE_IMAGE=sweb.env.py.x86_64.<env-hash>:latest \
  --build-arg SWE_BENCH_PLATFORM=linux/amd64 \
  -f eval/swebench/Dockerfile.worker \
  -t coding-agent-worker:sympy-env .
```

准备一个本地 repo cache，并确认它包含 task 的 `base_commit`。然后运行：

```bash
npm run eval:swebench:run -- \
  --tasks /tmp/swebench-sympy-20590.json \
  --task-id sympy__sympy-20590 \
  --repo-root /path/to/sympy \
  --workspace /tmp/swebench-workspaces/sympy-20590 \
  --results /tmp/swebench-results/sympy-20590 \
  --image coding-agent-worker:sympy-env \
  --container-workspace /testbed
```

`--repo-root` 是宿主机的本地仓库缓存；`--workspace` 是基于 `base_commit` 新建的 detached worktree，运行后保留，便于检查 diff。Worker 只收到 `problem_statement`，不会收到 gold patch 或测试补丁。

## 对已有候选补丁做官方测试

`eval:swebench:grade` 不启动模型，只把已有 workspace 挂载到独立 grader 容器，
由官方 SWE-bench 4.1.0 生成并解析测试脚本。它会输出 `FAIL_TO_PASS`、
`PASS_TO_PASS`、`resolved` 和完整日志路径：

```bash
npm run eval:swebench:grade -- \
  --tasks /tmp/swebench-sympy-20590.json \
  --task-id sympy__sympy-20590 \
  --workspace /tmp/swebench-workspaces/sympy-20590 \
  --results /tmp/swebench-grades/sympy-20590-v1 \
  --image coding-agent-worker:sympy-env \
  --python /Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python \
  --container-workspace /testbed
```

`--workspace` 应指向已经完成 Agent 修改的候选 workspace；`--results` 使用新的
目录，避免覆盖 Agent 的 session 数据。grader 阶段才读取官方测试补丁，Worker
阶段不会看到它。

## 批量运行 Agent + grader

批量命令按顺序处理 task，每题使用独立 workspace 和结果目录；中途单题失败会
记录错误并继续后面的 task，最后写入 `<results>/summary.json`。第一版要求输入
的 task 使用同一个 Worker 镜像（通常是同一仓库、同一版本的任务）：

```bash
npm run eval:swebench:batch -- \
  --tasks /tmp/swebench-sympy-20.json \
  --repo-root /tmp/sympy \
  --workspaces /tmp/swebench-workspaces/sympy-20 \
  --results /tmp/swebench-results/sympy-20 \
  --image coding-agent-worker:sympy-env \
  --python /Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python \
  --container-workspace /testbed \
  --max-steps 100 \
  --verbose
```

汇总会包含每题的 `run`、`grade`、workspace/log 路径，以及：

```text
taskCount
resolvedCount
resolvedRate
averageFailToPass
averagePassToPass
```

跨仓库批量评测暂时需要按环境分组；后续可以增加 task 到 Worker 镜像的映射。

## Pi + DeepSeek 对照基线

Pi baseline 使用与当前 Agent 相同的 task、`base_commit` 和官方 grader，但 Pi Worker 会直连 DeepSeek。因此它的 Docker 网络为 `bridge`，结果的 `executionProfile` 会标为 `direct-provider-egress`；当前 Agent 则是 `host-model-proxy` + Worker 断网。两者可比较正确性、耗时、工具行为和 token，不能宣称安全边界完全相同。

先用 BuildKit 的 named context 构建 Pi Worker。它只复制 Pi 源码和 Linux 依赖，不复制 Pi 的 `.pi` 配置、session、`node_modules` 或凭据：

```bash
cd /Users/titusliu/Documents/ai-agent
docker buildx build --load \
  --build-context pi=/Users/titusliu/Documents/ai-agent/pi \
  -f coding-agent/eval/swebench/Dockerfile.pi-worker \
  --build-arg SWE_BENCH_BASE_IMAGE=coding-agent-worker:sympy-env \
  --build-arg SWE_BENCH_PLATFORM=linux/amd64 \
  -t coding-agent-pi:sympy-env coding-agent
```

然后运行一题。运行 shell 必须已经导出 `DEEPSEEK_API_KEY`；命令不接收 `--api-key`，也不会把 key 写进日志或结果：

```bash
cd /Users/titusliu/Documents/ai-agent/coding-agent
npm run eval:swebench:pi -- \
  --tasks /tmp/swebench-sympy-20590.json \
  --task-id sympy__sympy-20590 \
  --repo-root /tmp/sympy \
  --workspace /tmp/swebench-pi-workspaces/sympy-20590 \
  --results /Users/titusliu/Documents/ai-agent/eval-results/pi-sympy-20590-v1 \
  --image coding-agent-pi:sympy-env \
  --python /Users/titusliu/Documents/ai-agent/.swebench-venv/bin/python \
  --container-workspace /testbed
```

这个命令自动完成 Pi 修改和官方 grading，并保留：

```text
run/pi.jsonl        Pi 完整 JSON 事件流
run/pi-session/     Pi 独立会话文件
run/agent.log       Pi stderr
grade/eval.log      官方 grader 日志
metrics.json        正确性、时间、token、工具行为和执行边界
```

Pi 每题固定传入 `--print --mode json --approve`；`--approve` 是 Pi 对本题目录项目资源的非交互 yes。它并不是逐工具确认，真实文件/命令边界仍由 Docker task workspace 提供。

## 本地 Web 评测控制台

可以用本地控制台点击启动评测、实时查看 Worker 日志、浏览历史 `summary.json`、
`session.sqlite` 和官方 `eval.log`，并让当前 provider 流式生成 Markdown 分析：

```bash
npm run eval:ui
```

浏览器打开 <http://127.0.0.1:3210>。首次使用时填写 task JSON、repo root、
workspaces、results、Worker image 和 SWE-bench Python 路径；表单会在浏览器本地
记住上次填写的值。API key 只由 Node 服务端读取 `config/settings.toml`，不会发送
给浏览器或 Docker Worker。

评测历史通过 results 根目录下的 run 子目录发现。每个 run 都有独立的 workspace
和结果目录；控制台只读展示会话和日志，不支持从旧评测恢复或续跑。

Run 详情支持两种分析：总分析/改进报告，以及每个 task 的单独分析。旧评测如果
没有单独的 `agent.log`，控制台会从该 task 的 `run/session.sqlite` 重建工具轨迹；
新评测则会同时保存 `agent.log`。
