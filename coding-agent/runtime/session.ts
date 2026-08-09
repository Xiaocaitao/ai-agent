import type { AgentItem } from "./responses.ts";

export type CompactionInput = {
  previousSummary?: string;
  throughTurnSequence: number;
  items: AgentItem[]; // 历史 item 需要进行摘要
  recentItems: AgentItem[]; // 最近两个完整 Turn 的 item
};

// Runtime 使用的 Session 存储适配接口。
export type SessionRecorder = {
  startTurn(userInput: string): Promise<string>;
  appendItem(turnId: string, item: AgentItem): Promise<void>;
  completeTurn(turnId: string): Promise<void>;
  failTurn(turnId: string, error: unknown): Promise<void>;
  prepareCompaction?(): Promise<CompactionInput | undefined>;
  saveCompaction?(
    summary: string,
    throughTurnSequence: number,
  ): Promise<void>;
};
