import assert from "node:assert/strict";
import test from "node:test";

test("aggregateBehavior aggregates behavior metrics while preserving missing values", async () => {
  const { aggregateBehavior } = await import("../../eval/ui/public/behavior_metrics.js");

  const result = aggregateBehavior([
    {
      metrics: {
        agentBehavior: {
          steps: 4,
          modelRequests: 3,
          toolCalls: 7,
          toolFailures: 1,
          verificationCommands: 2,
          contextCompactions: 0,
          toolCallsByName: { read_file: 3, run_command: 4 },
        },
      },
    },
    {
      metrics: {
        agentBehavior: {
          steps: 2,
          modelRequests: null,
          toolCalls: 5,
          toolFailures: 2,
          verificationCommands: 1,
          contextCompactions: 1,
          toolCallsByName: { read_file: 2, edit_file: 3 },
        },
      },
    },
  ]);

  assert.deepEqual(result, {
    steps: 6,
    modelRequests: 3,
    toolCalls: 12,
    toolFailures: 3,
    verificationCommands: 3,
    contextCompactions: 1,
    agentDurationMs: null,
    toolCallsByName: { read_file: 5, run_command: 4, edit_file: 3 },
  });
});

test("aggregateBehavior returns null totals when no behavior metrics exist", async () => {
  const { aggregateBehavior } = await import("../../eval/ui/public/behavior_metrics.js");

  assert.deepEqual(aggregateBehavior([{ taskId: "legacy" }, {}]), {
    steps: null,
    modelRequests: null,
    toolCalls: null,
    toolFailures: null,
    verificationCommands: null,
    contextCompactions: null,
    agentDurationMs: null,
    toolCallsByName: {},
  });
});
