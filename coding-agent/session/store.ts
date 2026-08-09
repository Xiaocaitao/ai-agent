import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { compactionMessage } from "../runtime/compaction.ts";
import type { AgentItem } from "../runtime/responses.ts";
import type {
  CompactionInput,
  SessionRecorder,
} from "../runtime/session.ts";

export type SessionRecord = {
  id: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  lastModel: string;
  systemPromptHash: string;
};

export type SessionSnapshot = {
  session: SessionRecord;
  items: AgentItem[];
  questions: string[];
  interruptedTurns: number;
};

type SessionStoreOptions = {
  now?: () => number;
  createId?: () => string;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sessionRecord(value: unknown): SessionRecord {
  const row = record(value);
  if (
    typeof row.id !== "string" ||
    typeof row.workspace_path !== "string" ||
    typeof row.created_at !== "number" ||
    typeof row.updated_at !== "number" ||
    typeof row.last_model !== "string" ||
    typeof row.system_prompt_hash !== "string"
  ) {
    throw new Error("Session 数据损坏");
  }
  return {
    id: row.id,
    workspacePath: row.workspace_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastModel: row.last_model,
    systemPromptHash: row.system_prompt_hash,
  };
}

function storedAgentItems(value: unknown): AgentItem[] {
  const message = record(value);
  if (
    typeof message.id !== "number" ||
    typeof message.payload_json !== "string"
  ) {
    throw new Error("Message 数据损坏");
  }
  try {
    const payload = record(JSON.parse(message.payload_json));
    if (![
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ].includes(String(payload.type))) {
      throw new Error("不是支持的 Responses item");
    }
    return [payload as AgentItem];
  } catch {
    throw new Error(`Message ${message.id} 数据损坏`);
  }
}

export class SessionStore {
  private readonly database: DatabaseSync;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(database: DatabaseSync, options: SessionStoreOptions = {}) {
    this.database = database;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  createSession(
    workspacePath: string,
    model: string,
    systemPromptHash: string,
  ): SessionRecord {
    const id = this.createId();
    const timestamp = this.now();
    this.database.prepare(`
      INSERT INTO sessions
        (id, workspace_path, created_at, updated_at, last_model, system_prompt_hash)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      workspacePath,
      timestamp,
      timestamp,
      model,
      systemPromptHash,
    );
    return {
      id,
      workspacePath,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastModel: model,
      systemPromptHash,
    };
  }

  findLatestSession(workspacePath: string): SessionRecord | undefined {
    const row = this.database.prepare(`
      SELECT
        id,
        workspace_path,
        created_at,
        updated_at,
        last_model,
        system_prompt_hash
      FROM sessions
      WHERE workspace_path = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(workspacePath);
    return row === undefined ? undefined : sessionRecord(row);
  }

  markSessionActive(sessionId: string, model: string): void {
    const result = this.database.prepare(`
      UPDATE sessions
      SET last_model = ?, updated_at = ?
      WHERE id = ?
    `).run(model, this.now(), sessionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Session ${sessionId} 不存在`);
    }
  }

  saveCompaction(
    sessionId: string,
    summary: string,
    throughTurnSequence: number,
  ): void {
    this.database.prepare(`
      INSERT INTO compactions
        (session_id, summary, through_turn_sequence, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        summary = excluded.summary,
        through_turn_sequence = excluded.through_turn_sequence,
        updated_at = excluded.updated_at
    `).run(sessionId, summary, throughTurnSequence, this.now());
  }

  prepareCompaction(sessionId: string): CompactionInput | undefined {
    // 上一次的摘要
    const compaction = record(this.database.prepare(`
      SELECT summary, through_turn_sequence
      FROM compactions
      WHERE session_id = ?
    `).get(sessionId));
    const hasCompaction = Object.keys(compaction).length > 0;
    if (
      hasCompaction &&
      (typeof compaction.summary !== "string" ||
        typeof compaction.through_turn_sequence !== "number")
    ) {
      throw new Error("Compaction 数据损坏");
    }
    const previousBoundary = hasCompaction
      ? Number(compaction.through_turn_sequence)
      : 0;

    // 倒数第三条
    const boundary = record(this.database.prepare(`
      SELECT sequence
      FROM turns
      WHERE session_id = ?
        AND status = 'completed'
        AND sequence > ?
      ORDER BY sequence DESC
      LIMIT 1 OFFSET 2
    `).get(sessionId, previousBoundary));
    if (typeof boundary.sequence !== "number") return undefined;

    // 收集待压缩完整message
    const items = this.database.prepare(`
      SELECT messages.id, messages.payload_json
      FROM messages
      JOIN turns ON turns.id = messages.turn_id
      WHERE messages.session_id = ?
        AND turns.status = 'completed'
        AND turns.sequence > ?
        AND turns.sequence <= ?
      ORDER BY messages.sequence
    `).all(sessionId, previousBoundary, boundary.sequence).flatMap(storedAgentItems);

    // 当前会话最近的两次message
    const recentItems = this.database.prepare(`
      SELECT messages.id, messages.payload_json
      FROM messages
      JOIN turns ON turns.id = messages.turn_id
      WHERE messages.session_id = ?
        AND turns.status = 'completed'
        AND turns.sequence > ?
      ORDER BY messages.sequence
    `).all(sessionId, boundary.sequence).flatMap(storedAgentItems);

    return {
      previousSummary: hasCompaction ? String(compaction.summary) : undefined,
      throughTurnSequence: boundary.sequence,
      items,
      recentItems,
    };
  }

  loadSnapshot(sessionId: string, workspacePath: string): SessionSnapshot {
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT
          id,
          workspace_path,
          created_at,
          updated_at,
          last_model,
          system_prompt_hash
        FROM sessions
        WHERE id = ?
      `).get(sessionId);
      if (row === undefined) {
        throw new Error(`Session ${sessionId} 不存在`);
      }

      const session = sessionRecord(row);
      if (session.workspacePath !== workspacePath) {
        throw new Error(`Session ${sessionId} 不属于当前工作区`);
      }

      const interrupted = this.database.prepare(`
        UPDATE turns
        SET status = 'interrupted', completed_at = ?
        WHERE session_id = ? AND status = 'running'
      `).run(this.now(), sessionId);

      // 拉摘要
      const compaction = record(this.database.prepare(`
        SELECT summary, through_turn_sequence
        FROM compactions
        WHERE session_id = ?
      `).get(sessionId));
      const hasCompaction = Object.keys(compaction).length > 0;
      if (
        hasCompaction &&
        (typeof compaction.summary !== "string" ||
          typeof compaction.through_turn_sequence !== "number")
      ) {
        throw new Error("Compaction 数据损坏");
      }
      const throughTurnSequence = hasCompaction
        ? Number(compaction.through_turn_sequence)
        : 0;

      // 拉未被压缩的完整消息
      const storedItems = this.database.prepare(`
        SELECT messages.id, messages.payload_json
        FROM messages
        JOIN turns ON turns.id = messages.turn_id
        WHERE messages.session_id = ?
          AND turns.status = 'completed'
          AND turns.sequence > ?
        ORDER BY messages.sequence
      `).all(sessionId, throughTurnSequence).flatMap(storedAgentItems);
      const items: AgentItem[] = hasCompaction
        ? [
            // 摘要包装
            compactionMessage(String(compaction.summary)),
            ...storedItems,
          ]
        : storedItems;

      const questions = this.database.prepare(`
        SELECT user_input
        FROM turns
        WHERE session_id = ?
          AND user_input <> ''
        ORDER BY sequence DESC
        LIMIT 100
      `).all(sessionId).map((value) => {
        const turn = record(value);
        if (typeof turn.user_input !== "string") {
          throw new Error("Turn 数据损坏");
        }
        return turn.user_input;
      });

      return {
        session,
        items,
        questions,
        interruptedTurns: Number(interrupted.changes),
      };
    });
  }

  // 适配器对象，绑定当前会话和使用sqlite
  recorder(sessionId: string): SessionRecorder {
    return {
      startTurn: async (userInput) => this.startTurn(sessionId, userInput),
      appendItem: async (turnId, item) =>
        this.appendItem(sessionId, turnId, item),
      completeTurn: async (turnId) =>
        this.finishTurn(sessionId, turnId, "completed"),
      failTurn: async (turnId, error) =>
        this.finishTurn(sessionId, turnId, "failed", error),
      prepareCompaction: async () => this.prepareCompaction(sessionId),
      saveCompaction: async (summary, throughTurnSequence) =>
        this.saveCompaction(sessionId, summary, throughTurnSequence),
    };
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // 保留原始数据库错误。
      }
      throw error;
    }
  }

  private nextSequence(table: "turns" | "messages", sessionId: string): number {
    const row = record(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
      FROM ${table}
      WHERE session_id = ?
    `).get(sessionId));
    if (
      typeof row.next_sequence !== "number" ||
      !Number.isInteger(row.next_sequence)
    ) {
      throw new Error(`无法生成 ${table} sequence`);
    }
    return row.next_sequence;
  }

  private touchSession(sessionId: string, timestamp: number): void {
    const result = this.database.prepare(`
      UPDATE sessions
      SET updated_at = ?
      WHERE id = ?
    `).run(timestamp, sessionId);
    if (Number(result.changes) !== 1) {
      throw new Error(`Session ${sessionId} 不存在`);
    }
  }

  private startTurn(sessionId: string, userInput: string): string {
    return this.transaction(() => {
      const turnId = this.createId();
      const timestamp = this.now();
      // 新一轮的uuid
      const sequence = this.nextSequence("turns", sessionId);
      this.database.prepare(`
        INSERT INTO turns
          (id, session_id, sequence, user_input, status, started_at)
        VALUES (?, ?, ?, ?, 'running', ?)
      `).run(turnId, sessionId, sequence, userInput, timestamp);
      this.touchSession(sessionId, timestamp);
      return turnId;
    });
  }

  private appendItem(
    sessionId: string,
    turnId: string,
    item: AgentItem,
  ): void {
    this.transaction(() => {
      const turn = this.database.prepare(`
        SELECT id
        FROM turns
        WHERE id = ? AND session_id = ? AND status = 'running'
      `).get(turnId, sessionId);
      if (turn === undefined) {
        throw new Error(`Turn ${turnId} 不存在或已经结束`);
      }

      const timestamp = this.now();
      const sequence = this.nextSequence("messages", sessionId);
      this.database.prepare(`
        INSERT INTO messages
          (session_id, turn_id, sequence, role, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        sessionId,
        turnId,
        sequence,
        item.type === "message" || item.type === undefined
          ? item.role
          : item.type,
        JSON.stringify(item),
        timestamp,
      );
      this.touchSession(sessionId, timestamp);
    });
  }

  private finishTurn(
    sessionId: string,
    turnId: string,
    status: "completed" | "failed",
    error?: unknown,
  ): void {
    this.transaction(() => {
      const timestamp = this.now();
      const errorMessage =
        status === "failed"
          ? error instanceof Error
            ? error.message
            : String(error)
          : null;
      const result = this.database.prepare(`
        UPDATE turns
        SET status = ?, completed_at = ?, error = ?
        WHERE id = ? AND session_id = ? AND status = 'running'
      `).run(status, timestamp, errorMessage, turnId, sessionId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Turn ${turnId} 不存在或已经结束`);
      }
      this.touchSession(sessionId, timestamp);
    });
  }
}
