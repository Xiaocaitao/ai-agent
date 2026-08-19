#!/usr/bin/env python3
"""Bridge to the installed official SWE-bench harness.

The candidate Worker never sees this file or the generated evaluation script.
The host invokes it only before/after the isolated grader container runs.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from swebench.harness.constants import FAIL_TO_PASS, PASS_TO_PASS, ResolvedStatus
from swebench.harness.grading import (
    compute_fail_to_pass,
    compute_pass_to_pass,
    get_eval_tests_report,
    get_logs_eval,
    get_resolution_status,
)
from swebench.harness.test_spec.test_spec import make_test_spec


def load_task(path: Path, task_id: str) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError("SWE-bench task 文件为空")
    try:
        parsed = json.loads(text)
        values = parsed if isinstance(parsed, list) else [parsed]
    except json.JSONDecodeError:
        values = [json.loads(line) for line in text.splitlines() if line.strip()]
    for value in values:
        if isinstance(value, dict) and value.get("instance_id") == task_id:
            return value
    raise ValueError(f"未找到 task: {task_id}")


def build_spec(tasks: Path, task_id: str):
    return make_test_spec(load_task(tasks, task_id), namespace="")


def grade_log(tasks: Path, task_id: str, log_path: Path) -> dict[str, Any]:
    spec = build_spec(tasks, task_id)
    status_map, patch_applied = get_logs_eval(spec, str(log_path))
    report = get_eval_tests_report(
        status_map,
        {FAIL_TO_PASS: spec.FAIL_TO_PASS, PASS_TO_PASS: spec.PASS_TO_PASS},
    )
    return {
        "taskId": task_id,
        "patchSuccessfullyApplied": patch_applied,
        "resolved": get_resolution_status(report) == ResolvedStatus.FULL.value,
        "resolutionStatus": get_resolution_status(report),
        "correctness": {
            "failToPass": compute_fail_to_pass(report),
            "passToPass": compute_pass_to_pass(report),
            "failToPassTests": report[FAIL_TO_PASS],
            "passToPassTests": report[PASS_TO_PASS],
        },
        "testsStatus": status_map,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tasks", required=True, type=Path)
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--emit-script", type=Path)
    parser.add_argument("--log", type=Path)
    args = parser.parse_args()
    if (args.emit_script is None) == (args.log is None):
        parser.error("必须且只能指定 --emit-script 或 --log")
    if args.emit_script is not None:
        args.emit_script.write_text(
            build_spec(args.tasks, args.task_id).eval_script,
            encoding="utf-8",
        )
        return
    print(json.dumps(grade_log(args.tasks, args.task_id, args.log), ensure_ascii=False))


if __name__ == "__main__":
    main()
