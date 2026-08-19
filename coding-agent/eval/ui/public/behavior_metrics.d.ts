export type BehaviorAggregate = {
  steps: number | null;
  modelRequests: number | null;
  toolCalls: number | null;
  toolFailures: number | null;
  verificationCommands: number | null;
  contextCompactions: number | null;
  agentDurationMs: number | null;
  toolCallsByName: Record<string, number>;
};

export function aggregateBehavior(tasks: unknown[]): BehaviorAggregate;
