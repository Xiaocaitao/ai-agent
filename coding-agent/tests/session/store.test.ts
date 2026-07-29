import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../../session/store.ts";
import { initializeStateDatabase } from "../../sqlite.ts";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function sessionFixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "coding-agent-session-store-test-"),
  );
  const databasePath = path.join(root, "state.sqlite");
  const database = await initializeStateDatabase(databasePath);
  return {
    database,
    async close() {
      database.close();
      for (const filePath of [
        `${databasePath}-shm`,
        `${databasePath}-wal`,
        databasePath,
      ]) {
        await unlink(filePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      await rmdir(root);
    },
  };
}

test("创建 Session 并按工作区查找最近会话", async () => {
  const fixture = await sessionFixture();
  try {
    const ids = ["session-1", "session-2"];
    let now = 100;
    const store = new SessionStore(fixture.database, {
      now: () => now,
      createId: () => ids.shift()!,
    });

    const first = store.createSession("/workspace", "model-a", "hash-a");
    now = 200;
    const second = store.createSession("/workspace", "model-b", "hash-b");

    assert.deepEqual(first, {
      id: "session-1",
      workspacePath: "/workspace",
      createdAt: 100,
      updatedAt: 100,
      lastModel: "model-a",
      systemPromptHash: "hash-a",
    });
    assert.deepEqual(second, {
      id: "session-2",
      workspacePath: "/workspace",
      createdAt: 200,
      updatedAt: 200,
      lastModel: "model-b",
      systemPromptHash: "hash-b",
    });
    assert.equal(store.findLatestSession("/workspace")?.id, "session-2");
    assert.equal(store.findLatestSession("/other"), undefined);
  } finally {
    await fixture.close();
  }
});

test("记录并完成一个 Turn 的有序消息", async () => {
  const fixture = await sessionFixture();
  try {
    const ids = ["session-1", "turn-1"];
    let now = 100;
    const store = new SessionStore(fixture.database, {
      now: () => ++now,
      createId: () => ids.shift()!,
    });
    const session = store.createSession("/workspace", "model", "hash");
    const recorder = store.recorder(session.id);

    const turnId = await recorder.startTurn("hello");
    await recorder.appendMessage(turnId, {
      role: "user",
      content: "hello",
    });
    await recorder.appendMessage(turnId, {
      role: "assistant",
      content: "world",
    });
    await recorder.completeTurn(turnId);

    const turn = record(
      fixture.database
        .prepare("SELECT * FROM turns WHERE id = ?")
        .get(turnId),
    );
    assert.equal(turn.session_id, session.id);
    assert.equal(turn.sequence, 1);
    assert.equal(turn.user_input, "hello");
    assert.equal(turn.status, "completed");
    assert.equal(typeof turn.completed_at, "number");

    const messages = fixture.database
      .prepare(`
        SELECT sequence, role, payload_json
        FROM messages
        WHERE turn_id = ?
        ORDER BY sequence
      `)
      .all(turnId)
      .map(record);
    assert.deepEqual(
      messages.map(({ sequence, role }) => ({ sequence, role })),
      [
        { sequence: 1, role: "user" },
        { sequence: 2, role: "assistant" },
      ],
    );
    assert.equal(JSON.parse(String(messages[1]?.payload_json)).content, "world");
  } finally {
    await fixture.close();
  }
});

test("Turn 失败时保存失败状态和原因", async () => {
  const fixture = await sessionFixture();
  try {
    const ids = ["session-1", "turn-1"];
    const store = new SessionStore(fixture.database, {
      now: () => 100,
      createId: () => ids.shift()!,
    });
    const session = store.createSession("/workspace", "model", "hash");
    const recorder = store.recorder(session.id);

    const turnId = await recorder.startTurn("fail");
    await recorder.failTurn(turnId, new Error("model unavailable"));

    const turn = record(
      fixture.database
        .prepare("SELECT status, error FROM turns WHERE id = ?")
        .get(turnId),
    );
    assert.equal(turn.status, "failed");
    assert.equal(turn.error, "model unavailable");
  } finally {
    await fixture.close();
  }
});

test("恢复时中断未完成 Turn 且只加载完整消息", async () => {
  const fixture = await sessionFixture();
  try {
    const ids = ["session-1", "turn-1", "turn-2"];
    const store = new SessionStore(fixture.database, {
      now: () => 100,
      createId: () => ids.shift()!,
    });
    const session = store.createSession("/workspace", "model", "hash");
    const recorder = store.recorder(session.id);

    const completedTurn = await recorder.startTurn("completed question");
    await recorder.appendMessage(completedTurn, {
      role: "user",
      content: "completed question",
    });
    await recorder.appendMessage(completedTurn, {
      role: "assistant",
      content: "completed answer",
    });
    await recorder.completeTurn(completedTurn);

    const interruptedTurn = await recorder.startTurn("interrupted question");
    await recorder.appendMessage(interruptedTurn, {
      role: "user",
      content: "interrupted question",
    });

    const snapshot = store.loadSnapshot(session.id, "/workspace");

    assert.equal(snapshot.interruptedTurns, 1);
    assert.deepEqual(
      snapshot.messages.map(({ role, content }) => ({ role, content })),
      [
        { role: "user", content: "completed question" },
        { role: "assistant", content: "completed answer" },
      ],
    );
    assert.deepEqual(snapshot.questions, [
      "interrupted question",
      "completed question",
    ]);
    assert.equal(
      record(
        fixture.database
          .prepare("SELECT status FROM turns WHERE id = ?")
          .get(interruptedTurn),
      ).status,
      "interrupted",
    );
  } finally {
    await fixture.close();
  }
});

test("损坏的消息 JSON 返回 Message ID 且不泄露正文", async () => {
  const fixture = await sessionFixture();
  try {
    const ids = ["session-1", "turn-1"];
    const store = new SessionStore(fixture.database, {
      now: () => 100,
      createId: () => ids.shift()!,
    });
    const session = store.createSession("/workspace", "model", "hash");
    const recorder = store.recorder(session.id);
    const turnId = await recorder.startTurn("question");
    await recorder.appendMessage(turnId, {
      role: "user",
      content: "question",
    });
    await recorder.completeTurn(turnId);

    const messageId = Number(
      record(
        fixture.database
          .prepare("SELECT id FROM messages WHERE turn_id = ?")
          .get(turnId),
      ).id,
    );
    fixture.database
      .prepare("UPDATE messages SET payload_json = ? WHERE id = ?")
      .run("{sensitive broken payload", messageId);

    assert.throws(
      () => store.loadSnapshot(session.id, "/workspace"),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, new RegExp(`Message ${messageId}`));
        assert.doesNotMatch(message, /sensitive broken payload/);
        return true;
      },
    );
  } finally {
    await fixture.close();
  }
});

test("拒绝恢复不存在或属于其他工作区的 Session", async () => {
  const fixture = await sessionFixture();
  try {
    const store = new SessionStore(fixture.database, {
      now: () => 100,
      createId: () => "session-1",
    });
    const session = store.createSession("/workspace", "model", "hash");

    assert.throws(
      () => store.loadSnapshot("missing", "/workspace"),
      /Session missing 不存在/,
    );
    assert.throws(
      () => store.loadSnapshot(session.id, "/other"),
      /不属于当前工作区/,
    );
  } finally {
    await fixture.close();
  }
});

test("恢复时只返回最近 100 条非空历史提问", async () => {
  const fixture = await sessionFixture();
  try {
    const store = new SessionStore(fixture.database, {
      now: () => 100,
      createId: () => "session-1",
    });
    const session = store.createSession("/workspace", "model", "hash");
    const insertTurn = fixture.database.prepare(`
      INSERT INTO turns
        (id, session_id, sequence, user_input, status, started_at, completed_at)
      VALUES (?, ?, ?, ?, 'completed', ?, ?)
    `);
    for (let sequence = 1; sequence <= 102; sequence += 1) {
      insertTurn.run(
        `turn-${sequence}`,
        session.id,
        sequence,
        sequence === 102 ? "" : `question-${sequence}`,
        sequence,
        sequence,
      );
    }

    const snapshot = store.loadSnapshot(session.id, "/workspace");

    assert.equal(snapshot.questions.length, 100);
    assert.equal(snapshot.questions[0], "question-101");
    assert.equal(snapshot.questions.at(-1), "question-2");
  } finally {
    await fixture.close();
  }
});
