import test from "node:test";
import assert from "node:assert/strict";

import { parseGradeTaskArguments } from "../../scripts/swebench/grade_task.ts";

test("grade CLI parses required arguments and defaults", () => {
  const args = parseGradeTaskArguments([
    "--tasks", "/tmp/task.json",
    "--task-id", "sympy__sympy-20590",
    "--workspace", "/tmp/workspace",
    "--results", "/tmp/results",
    "--image", "coding-agent-worker:sympy-env",
    "--python", "/tmp/python",
  ]);
  assert.equal(args.containerWorkspace, "/testbed");
  assert.equal(args.containerResults, "/results");
});

test("grade CLI rejects missing values", () => {
  assert.throws(
    () => parseGradeTaskArguments(["--tasks"]),
    /参数 --tasks 缺少值/,
  );
});
