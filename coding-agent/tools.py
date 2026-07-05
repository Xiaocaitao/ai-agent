"""本地工具实现，通过 config/tools.json 注册。"""

import fnmatch
import os
import subprocess
import tempfile
from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parent
MAX_OUTPUT_CHARS = 20_000
MAX_SEARCH_RESULTS = 100
IGNORED_DIRS = {".git", ".venv", ".idea", "__pycache__"}
DELETE_COMMANDS = {"rm", "rmdir", "unlink", "del", "rd", "remove-item"}


def _success(data):
    return {"ok": True, "data": data, "error": None}


def _failure(error, data=None):
    return {"ok": False, "data": data or {}, "error": str(error)}


def _workspace_path(path):
    if not isinstance(path, str) or not path:
        raise ValueError("路径必须是非空字符串")
    root = WORKSPACE_ROOT.resolve()
    resolved = (root / path).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("路径不能超出工作区")
    return resolved, resolved.relative_to(root).as_posix() or "."


def _truncate(text):
    text = text or ""
    return text[:MAX_OUTPUT_CHARS], len(text) > MAX_OUTPUT_CHARS


def _decode_timeout_output(value):
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value or ""


def run_command(args, stdin=None, cwd=".", timeout=30):
    """运行单次非 Shell 命令并返回 stdout、stderr 和退出码。"""
    if not isinstance(args, list) or not args or not all(isinstance(arg, str) for arg in args):
        return _failure("args 必须是非空字符串数组")
    if stdin is not None and not isinstance(stdin, str):
        return _failure("stdin 必须是字符串或 null")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
        return _failure("timeout 必须在 1 到 120 秒之间")

    executable = Path(args[0]).name.casefold()
    if executable in DELETE_COMMANDS or (
        executable == "git" and len(args) > 1 and args[1].casefold() == "clean"
    ):
        return _failure("终端工具不允许执行文件删除命令")

    try:
        workdir, relative_cwd = _workspace_path(cwd)
        if not workdir.is_dir():
            return _failure(f"cwd 不是目录: {relative_cwd}")
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
        stdout, stdout_truncated = _truncate(completed.stdout)
        stderr, stderr_truncated = _truncate(completed.stderr)
        data = {
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": completed.returncode,
            "timed_out": False,
            "truncated": stdout_truncated or stderr_truncated,
        }
        if completed.returncode == 0:
            return _success(data)
        return _failure(f"命令退出码: {completed.returncode}", data)
    except subprocess.TimeoutExpired as error:
        stdout, stdout_truncated = _truncate(_decode_timeout_output(error.stdout))
        stderr, stderr_truncated = _truncate(_decode_timeout_output(error.stderr))
        return _failure(
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
        return _failure(error)


def read_file(path, start_line=1, max_lines=200):
    """读取工作区内的 UTF-8 文本文件。"""
    if type(start_line) is not int or start_line < 1:
        return _failure("start_line 必须是正整数")
    if type(max_lines) is not int or max_lines < 1:
        return _failure("max_lines 必须是正整数")
    try:
        target, relative_path = _workspace_path(path)
        lines = target.read_text(encoding="utf-8").splitlines(keepends=True)
        start = start_line - 1
        selected = lines[start : start + max_lines]
        content, char_truncated = _truncate("".join(selected))
        end_line = min(start + len(selected), len(lines))
        return _success(
            {
                "path": relative_path,
                "content": content,
                "start_line": start_line,
                "end_line": end_line,
                "truncated": char_truncated or start + max_lines < len(lines),
            }
        )
    except (OSError, UnicodeError, ValueError) as error:
        return _failure(error)


def write_file(path, content):
    """原子写入工作区内的 UTF-8 文件。"""
    if not isinstance(content, str):
        return _failure("content 必须是字符串")
    temporary_path = None
    try:
        target, relative_path = _workspace_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_path = tempfile.mkstemp(prefix=".agent-", dir=target.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(content)
        os.replace(temporary_path, target)
        temporary_path = None
        return _success(
            {"path": relative_path, "bytes_written": len(content.encode("utf-8"))}
        )
    except (OSError, ValueError) as error:
        return _failure(error)
    finally:
        if temporary_path:
            try:
                Path(temporary_path).unlink()
            except OSError:
                pass


def search_files(query, path=".", pattern="*"):
    """在工作区文本文件中执行大小写敏感的普通字符串搜索。"""
    if not isinstance(query, str) or not query:
        return _failure("query 必须是非空字符串")
    if not isinstance(pattern, str) or not pattern:
        return _failure("pattern 必须是非空字符串")
    try:
        search_root, _ = _workspace_path(path)
        if not search_root.is_dir():
            return _failure("搜索路径不是目录")

        matches = []
        workspace = WORKSPACE_ROOT.resolve()
        for current, directories, filenames in os.walk(search_root, followlinks=False):
            directories[:] = [name for name in directories if name not in IGNORED_DIRS]
            for filename in filenames:
                if not fnmatch.fnmatch(filename, pattern):
                    continue
                file_path = Path(current) / filename
                if file_path.is_symlink():
                    continue
                try:
                    with file_path.open("rb") as file:
                        if b"\x00" in file.read(4096):
                            continue
                    with file_path.open("r", encoding="utf-8") as file:
                        for line_number, line in enumerate(file, 1):
                            if query not in line:
                                continue
                            if len(matches) == MAX_SEARCH_RESULTS:
                                return _success({"matches": matches, "truncated": True})
                            matches.append(
                                {
                                    "path": file_path.resolve().relative_to(workspace).as_posix(),
                                    "line": line_number,
                                    "text": line.rstrip("\n"),
                                }
                            )
                except (OSError, UnicodeError):
                    continue
        return _success({"matches": matches, "truncated": False})
    except (OSError, ValueError) as error:
        return _failure(error)
