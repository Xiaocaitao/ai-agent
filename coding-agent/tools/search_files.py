import fnmatch
import os
from pathlib import Path

from . import _common
from ._common import (
    IGNORED_DIRS,
    MAX_SEARCH_RESULTS,
    failure,
    success,
    workspace_path,
)


def search_files(query, path=".", pattern="*"):
    """在工作区文本文件中执行大小写敏感的普通字符串搜索。"""
    if not isinstance(query, str) or not query:
        return failure("query 必须是非空字符串")
    if not isinstance(pattern, str) or not pattern:
        return failure("pattern 必须是非空字符串")
    try:
        search_root, _ = workspace_path(path)
        if not search_root.is_dir():
            return failure("搜索路径不是目录")

        matches = []
        workspace = _common.WORKSPACE_ROOT.resolve()
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
                                return success({"matches": matches, "truncated": True})
                            matches.append(
                                {
                                    "path": file_path.resolve().relative_to(workspace).as_posix(),
                                    "line": line_number,
                                    "text": line.rstrip("\n"),
                                }
                            )
                except (OSError, UnicodeError):
                    continue
        return success({"matches": matches, "truncated": False})
    except (OSError, ValueError) as error:
        return failure(error)
