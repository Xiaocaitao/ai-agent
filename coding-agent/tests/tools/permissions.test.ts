import assert from "node:assert/strict";
import test from "node:test";

import { PermissionEngine } from "../../tools/permissions.ts";

test("allow 直接放行且不请求审批", async () => {
  let approvals = 0;
  const engine = new PermissionEngine(
    { read_file: "allow" },
    async () => {
      approvals += 1;
      return "reject";
    },
  );

  assert.deepEqual(await engine.authorize("read_file", { path: "a.ts" }), {
    allowed: true,
    action: "allow",
  });
  assert.equal(approvals, 0);
});

test("ask 支持仅本次、本会话和拒绝", async () => {
  const choices = ["once", "session", "reject"] as const;
  let approvalIndex = 0;
  const engine = new PermissionEngine(
    { write_file: "ask" },
    async () => choices[approvalIndex++] ?? "reject",
  );

  assert.equal((await engine.authorize("write_file", { path: "a/../a.ts", content: "1" })).allowed, true);
  assert.equal((await engine.authorize("write_file", { path: "a.ts", content: "2" })).allowed, true);
  assert.equal((await engine.authorize("write_file", { path: "a.ts", content: "3" })).allowed, true);
  assert.equal((await engine.authorize("write_file", { path: "b.ts", content: "4" })).allowed, false);
  assert.equal(approvalIndex, 3);
});

test("危险命令强制 deny 且不能被会话授权绕过", async () => {
  let approvals = 0;
  const engine = new PermissionEngine(
    { run_command: "ask" },
    async () => {
      approvals += 1;
      return "session";
    },
  );

  assert.equal((await engine.authorize("run_command", { args: ["git", "status"] })).allowed, true);
  const denied = await engine.authorize("run_command", { args: ["git", "reset", "--hard"] });
  assert.equal(denied.allowed, false);
  assert.equal(denied.action, "deny");
  assert.match(denied.reason ?? "", /危险命令/);
  assert.equal(approvals, 1);
});

test("deny 和审批异常返回拒绝结果", async () => {
  const denied = new PermissionEngine({ write_file: "deny" });
  assert.equal((await denied.authorize("write_file", { path: "a.ts" })).allowed, false);

  const failed = new PermissionEngine({ write_file: "ask" }, async () => {
    throw new Error("terminal closed");
  });
  const result = await failed.authorize("write_file", { path: "a.ts" });
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /审批失败/);
});
