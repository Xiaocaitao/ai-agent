import subprocess
from pathlib import Path

from ._common import failure, success, truncate, workspace_path


DELETE_COMMANDS = {"rm", "rmdir", "unlink", "del", "rd", "remove-item"}


def _decode_timeout_output(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def run_command(args, stdin=None, cwd=".", timeout=30):
    """运行单次非 Shell 命令并返回 stdout、stderr 和退出码。"""
    if not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args):
        return failure("args 必须是非空字符串数组")
    if stdin is not None and not isinstance(stdin, str):
        return failure("stdin 必须是字符串或 null")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
        return failure("timeout 必须在 1 到 120 秒之间")

    executable = Path(args[0]).name.casefold()
    if executable in DELETE_COMMANDS or (
        executable == "git" and len(args) > 1 and args[1].casefold() == "clean"
    ):
        return failure("终端工具不允许执行文件删除命令")

    try:
        workdir, relative_cwd = workspace_path(cwd)
        if not workdir.is_dir():
            return failure(f"cwd 不是目录: {relative_cwd}")
        completed = subprocess.run(
            args,
            cwd=workdir,
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
            check=False,
        )
        stdout, stdout_truncated = truncate(completed.stdout)
        stderr, stderr_truncated = truncate(completed.stderr)
        data = {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": completed.returncode,
            "timed_out": False,
            "truncated": stdout_truncated or stderr_truncated,
        }
        if completed.returncode == 0:
            return success(data)
        return failure(f"命令退出码: {completed.returncode}", data)
    except subprocess.TimeoutExpired as error:
        stdout, stdout_truncated = truncate(_decode_timeout_output(error.stdout))
        stderr, stderr_truncated = truncate(_decode_timeout_output(error.stderr))
        return failure(
            f"命令执行超时: {timeout} 秒",
            {
                "stdout": stdout,
                "stderr": stderr,
                "exit_code": None,
                "timed_out": True,
                "truncated": stdout_truncated or stderr_truncated,
            },
        )
    except (OSError, ValueError) as error:
        return failure(error)
