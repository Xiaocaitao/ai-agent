import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";

import { configureWorkspace, runCommand } from "../tools/index.ts";

const enabled =
  process.platform === "darwin" &&
  process.env.RUN_MACOS_SANDBOX_TESTS === "1";

test(
  "Seatbelt 允许工作区写入并拒绝工作区外读写",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(
      path.join(homedir(), ".coding-agent-sandbox-"),
    );
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside.txt");
    const inside = path.join(workspace, "inside.txt");
    await mkdir(workspace);
    await writeFile(outside, "outside");
    configureWorkspace(workspace);

    try {
      const allowed = await runCommand([
        "/bin/sh",
        "-c",
        "echo inside > inside.txt",
      ]);
      assert.equal(allowed.ok, true);
      assert.equal(allowed.data.sandboxed, true);
      assert.equal(await readFile(inside, "utf8"), "inside\n");

      const readDenied = await runCommand(["/bin/cat", outside]);
      assert.equal(readDenied.ok, false);
      assert.equal(readDenied.data.sandbox_denied, true);

      const writeDenied = await runCommand([
        "/bin/sh",
        "-c",
        `echo changed > ${JSON.stringify(outside)}`,
      ]);
      assert.equal(writeDenied.ok, false);
      assert.equal(writeDenied.data.sandbox_denied, true);
      assert.equal(await readFile(outside, "utf8"), "outside");
    } finally {
      try {
        await unlink(inside);
      } catch {}
      await unlink(outside);
      await rmdir(workspace);
      await rmdir(root);
    }
  },
);

test(
  "Seatbelt 在工作区内仍拒绝读取 .env",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(
      path.join(homedir(), ".coding-agent-sandbox-env-"),
    );
    const envFile = path.join(root, ".env");
    await writeFile(envFile, "SECRET=value\n");
    configureWorkspace(root);

    try {
      const result = await runCommand(["/bin/cat", envFile]);
      assert.equal(result.ok, false);
      assert.equal(result.data.sandbox_denied, true);
    } finally {
      await unlink(envFile);
      await rmdir(root);
    }
  },
);

test(
  "Seatbelt 网络限制继承给 Shell 启动的 Python",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(
      path.join(homedir(), ".coding-agent-sandbox-network-"),
    );
    configureWorkspace(root);

    try {
      const result = await runCommand([
        "/bin/sh",
        "-c",
        "/usr/bin/python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 443), 2)'",
      ]);
      assert.equal(result.ok, false);
      assert.equal(result.data.sandboxed, true);
      assert.equal(result.data.sandbox_denied, true);
    } finally {
      await rmdir(root);
    }
  },
);

test(
  "沙箱命令不继承 Agent 密钥和代理凭据",
  { skip: !enabled },
  async () => {
    const root = await mkdtemp(
      path.join(homedir(), ".coding-agent-sandbox-envvars-"),
    );
    const previousApiKey = process.env.AGENT_API_KEY;
    const previousProxy = process.env.HTTP_PROXY;
    process.env.AGENT_API_KEY = "should-not-leak";
    process.env.HTTP_PROXY = "http://user:pass@example.com";
    configureWorkspace(root);

    try {
      const result = await runCommand(["/usr/bin/env"]);
      assert.equal(result.ok, true);
      assert.doesNotMatch(String(result.data.stdout), /AGENT_API_KEY/);
      assert.doesNotMatch(String(result.data.stdout), /HTTP_PROXY/);
    } finally {
      if (previousApiKey === undefined) delete process.env.AGENT_API_KEY;
      else process.env.AGENT_API_KEY = previousApiKey;
      if (previousProxy === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = previousProxy;
      await rmdir(root);
    }
  },
);
