import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  loadSWEbenchTasks,
  parseSWEbenchTask,
  toWorkerInput,
} from "../../eval/swebench/task.ts";

test("解析 SWE-bench 任务时只把公开问题描述交给 Worker", () => {
  const task = parseSWEbenchTask(JSON.stringify({
    instance_id: "sympy__sympy-20590",
    repo: "sympy/sympy",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    problem_statement: "Fix the parser regression.",
    FAIL_TO_PASS: ["sympy/tests/test_parser.py::test_regression"],
    PASS_TO_PASS: ["sympy/tests/test_parser.py::test_existing"],
    patch: "gold patch must not enter the Worker",
    test_patch: "hidden test patch must not enter the Worker",
  }));

  assert.equal(task.instanceId, "sympy__sympy-20590");
  assert.deepEqual(task.failToPass, ["sympy/tests/test_parser.py::test_regression"]);
  assert.deepEqual(toWorkerInput(task), {
    taskId: "sympy__sympy-20590",
    problemStatement: "Fix the parser regression.",
  });
  assert.equal("patch" in toWorkerInput(task), false);
  assert.equal("test_patch" in toWorkerInput(task), false);
});

test("JSONL 加载器拒绝重复任务和缺少关键字段", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "swebench-tasks-"));
  const file = path.join(root, "tasks.jsonl");
  const task = {
    instance_id: "django__django-1",
    repo: "django/django",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    problem_statement: "Fix it.",
    FAIL_TO_PASS: [],
    PASS_TO_PASS: [],
  };
  await writeFile(file, `${JSON.stringify(task)}\n${JSON.stringify(task)}\n`);
  await assert.rejects(
    loadSWEbenchTasks(file),
    /重复的 SWE-bench task: django__django-1/,
  );
  assert.throws(
    () => parseSWEbenchTask(JSON.stringify({ ...task, base_commit: "" })),
    /base_commit 不能为空/,
  );
});
