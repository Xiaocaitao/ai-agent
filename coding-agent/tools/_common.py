from pathlib import Path


WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
MAX_OUTPUT_CHARS = 20_000
MAX_SEARCH_RESULTS = 100
IGNORED_DIRS = {".git", ".venv", ".idea", "__pycache__"}


def resolve_workspace(path):
    workspace = Path(path).expanduser().resolve()
    if not workspace.is_dir():
        raise ValueError(f"工作目录不存在或不是目录: {workspace}")
    return workspace


def configure_workspace(path):
    global WORKSPACE_ROOT
    WORKSPACE_ROOT = resolve_workspace(path)
    return WORKSPACE_ROOT


def success(data):
    return {"ok": True, "data": data, "error": None}


def failure(error, data=None):
    return {"ok": False, "data": data or {}, "error": str(error)}


def workspace_path(path):
    if not isinstance(path, str) or not path:
        raise ValueError("路径必须是非空字符串")
    root = WORKSPACE_ROOT.resolve()
    resolved = (root / path).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("路径不能超出工作区")
    return resolved, resolved.relative_to(root).as_posix() or "."


def truncate(text):
    text = text or ""
    return text[:MAX_OUTPUT_CHARS], len(text) > MAX_OUTPUT_CHARS
