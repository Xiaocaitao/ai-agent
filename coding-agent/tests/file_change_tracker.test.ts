import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FileChangeTracker } from "../file_change_tracker.ts";
import { configureWorkspace } from "../tools/index.ts";

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "coding-agent-changes-test-"));
}

test("FileChangeTracker 返回单次文件修改的 unified diff", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "example.ts");
  await writeFile(target, "const enabled = false;\n");
  configureWorkspace(root);
  const tracker = new FileChangeTracker();
  tracker.beginTurn();

  const capture = await tracker.captureBefore("example.ts");
  await writeFile(target, "const enabled = true;\n");
  const change = await tracker.captureAfter(capture);

  assert.ok(change);
  assert.equal(change.path, "example.ts");
  assert.equal(change.truncated, false);
  assert.match(change.diff, /--- a\/example\.ts/);
  assert.match(change.diff, /\+\+\+ b\/example\.ts/);
  assert.match(change.diff, /-const enabled = false;/);
  assert.match(change.diff, /\+const enabled = true;/);
});

test("FileChangeTracker 将同一 Turn 的多次修改合并为最初到最终的 diff", async () => {
  const root = await temporaryDirectory();
  const target = path.join(root, "example.ts");
  await writeFile(target, "const state = 'initial';\n");
  configureWorkspace(root);
  const tracker = new FileChangeTracker();
  tracker.beginTurn();

  const firstCapture = await tracker.captureBefore("example.ts");
  await writeFile(target, "const state = 'middle';\n");
  await tracker.captureAfter(firstCapture);

  const secondCapture = await tracker.captureBefore("example.ts");
  await writeFile(target, "const state = 'final';\n");
  await tracker.captureAfter(secondCapture);

  const changes = tracker.finishTurn();
  assert.equal(changes.length, 1);
  assert.match(changes[0].diff, /-const state = 'initial';/);
  assert.match(changes[0].diff, /\+const state = 'final';/);
  assert.doesNotMatch(changes[0].diff, /middle/);
});
