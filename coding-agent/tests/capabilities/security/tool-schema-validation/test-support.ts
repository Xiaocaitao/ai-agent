import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReActAgent } from "../../../../agent.ts";
import { configureWorkspace } from "../../../../tools/index.ts";
import { loadTools } from "../../../../tools/registry.ts";

export function toolCall(name: string, argumentsValue: Record<string, unknown>, id = name) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(argumentsValue) },
  };
}

export function message(content: string | null = null, toolCalls: ReturnType<typeof toolCall>[] = []) {
  return { content, tool_calls: toolCalls };
}

export async function createTestAgent(...responses: ReturnType<typeof message>[]) {
  const root = await mkdtemp(path.join(tmpdir(), "coding-agent-schema-test-"));
  configureWorkspace(root);
  const tools = await loadTools();
  const calls: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          calls.push(request);
          return { choices: [{ message: responses.shift()! }] };
        },
      },
    },
  };
  return {
    agent: new ReActAgent(client, "model-x", "prompt", tools, 5),
    calls,
    root,
  };
}

export function toolObservation(agent: ReActAgent, index = 3): Record<string, unknown> {
  return JSON.parse(String(agent.messages[index]?.content)) as Record<string, unknown>;
}
