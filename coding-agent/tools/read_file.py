from ._common import failure, success, truncate, workspace_path


def read_file(path, start_line=1, max_lines=200):
    """读取工作区内的 UTF-8 文本文件。"""
    if type(start_line) is not int or start_line < 1:
        return failure("start_line 必须是正整数")
    if type(max_lines) is not int or max_lines < 1:
        return failure("max_lines 必须是正整数")
    try:
        target, relative_path = workspace_path(path)
        lines = target.read_text(encoding="utf-8").splitlines(keepends=True)
        start = start_line - 1
        selected = lines[start : start + max_lines]
        content, char_truncated = truncate("".join(selected))
        end_line = min(start + len(selected), len(lines))
        return success(
            {
                "path": relative_path,
                "content": content,
                "start_line": start_line,
                "end_line": end_line,
                "truncated": char_truncated or start + max_lines < len(lines),
            }
        )
    except (OSError, UnicodeError, ValueError) as error:
        return failure(error)
