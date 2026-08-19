"""Generate the fixed SWE-bench Lite baseline-v1 task file.

The dataset is loaded from the local Hugging Face cache when available.  The
selected instance IDs are intentionally fixed so later Agent/harness changes
can be compared on exactly the same tasks.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from datasets import load_dataset


SYMPY_BASELINE_TASK_IDS = [
    "sympy__sympy-19254",
    "sympy__sympy-19487",
    "sympy__sympy-20049",
    "sympy__sympy-11400",
    "sympy__sympy-11870",
    "sympy__sympy-11897",
    "sympy__sympy-12171",
    "sympy__sympy-12236",
    "sympy__sympy-12419",
    "sympy__sympy-12454",
]

MULTI_REPO_BASELINE_TASK_IDS = [
    "sympy__sympy-19254",
    "sympy__sympy-19487",
    "sympy__sympy-20049",
    "astropy__astropy-12907",
    "django__django-10914",
    "matplotlib__matplotlib-18869",
    "pytest-dev__pytest-11143",
    "scikit-learn__scikit-learn-10297",
    "psf__requests-1963",
    "sphinx-doc__sphinx-10325",
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--profile", choices=("sympy", "multi-repo"), default="sympy")
    args = parser.parse_args()

    dataset = load_dataset("SWE-bench/SWE-bench_Lite", split="test")
    by_id = {row["instance_id"]: row for row in dataset}
    selected_ids = SYMPY_BASELINE_TASK_IDS if args.profile == "sympy" else MULTI_REPO_BASELINE_TASK_IDS
    missing = [task_id for task_id in selected_ids if task_id not in by_id]
    if missing:
        raise SystemExit(f"dataset 缺少固定 baseline task: {', '.join(missing)}")

    tasks = [by_id[task_id] for task_id in selected_ids]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(tasks, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"写入 {len(tasks)} 个 baseline task: {args.output}")
    for index, task in enumerate(tasks, start=1):
        print(f"{index:02d}. {task['instance_id']} ({task['repo']})")


if __name__ == "__main__":
    main()
