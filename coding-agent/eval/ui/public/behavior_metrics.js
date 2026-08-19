const NUMERIC_KEYS = [
  "steps",
  "modelRequests",
  "toolCalls",
  "toolFailures",
  "verificationCommands",
  "contextCompactions",
  "agentDurationMs",
];

export function aggregateBehavior(tasks) {
  const totals = Object.fromEntries(NUMERIC_KEYS.map((key) => [key, null]));
  const toolCallsByName = {};

  for (const task of tasks || []) {
    const behavior = task?.metrics?.agentBehavior;
    if (!behavior) continue;

    for (const key of NUMERIC_KEYS) {
      const value = behavior[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      totals[key] = totals[key] === null ? value : totals[key] + value;
    }

    const agentDuration = task?.metrics?.durationMs?.agent ?? behavior.sessionDurationMs;
    if (typeof agentDuration === "number" && Number.isFinite(agentDuration)) {
      totals.agentDurationMs = totals.agentDurationMs === null ? agentDuration : totals.agentDurationMs + agentDuration;
    }

    for (const [name, value] of Object.entries(behavior.toolCallsByName || {})) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      toolCallsByName[name] = (toolCallsByName[name] || 0) + value;
    }
  }

  return { ...totals, toolCallsByName };
}
