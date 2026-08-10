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
