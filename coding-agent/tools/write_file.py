import os
import tempfile
from pathlib import Path

from ._common import failure, success, workspace_path


def write_file(path, content):
    """原子写入工作区内的 UTF-8 文件。"""
    if not isinstance(content, str):
        return failure("content 必须是字符串")
    temporary_path = None
    try:
        target, relative_path = workspace_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_path = tempfile.mkstemp(prefix=".agent-", dir=target.parent)
        with os.fdopen(descriptor, "w", encoding="utf-8") as file:
            file.write(content)
        os.replace(temporary_path, target)
        temporary_path = None
        return success(
            {"path": relative_path, "bytes_written": len(content.encode("utf-8"))}
        )
    except (OSError, ValueError) as error:
        return failure(error)
    finally:
        if temporary_path:
            try:
                Path(temporary_path).unlink()
            except OSError:
                pass
