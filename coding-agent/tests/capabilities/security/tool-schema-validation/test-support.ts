import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ReActAgent } from "../../../../runtime/agent.ts";
import { configureWorkspace } from "../../../../tools/index.ts";
import { loadTools } from "../../../../tools/registry.ts";
import { responseForRequest } from "../../../support/responses.ts";

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
  const tools = await loadTools(undefined, async () => "once");
  const calls: unknown[] = [];
  const client = {
    responses: {
      create: async (request: unknown) => {
        calls.push(request);
        const current = responses.shift()!;
        return responseForRequest(request, {
          output: [
            ...(current.tool_calls ?? []).map((call) => ({
              type: "function_call" as const,
              call_id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            })),
            ...(current.content === null ? [] : [{
              id: "message-1",
              type: "message" as const,
              role: "assistant" as const,
              status: "completed" as const,
              content: [{
                type: "output_text" as const,
                text: current.content,
                annotations: [],
                logprobs: [],
              }],
            }]),
          ],
          output_text: current.content ?? "",
          status: "completed" as const,
        });
      },
    },
  };
  return {
    agent: new ReActAgent(client, "model-x", "prompt", tools, 5),
    calls,
    root,
  };
}

export function toolObservation(agent: ReActAgent): Record<string, unknown> {
  const output = agent.items.find((item) => item.type === "function_call_output");
  return JSON.parse(String(output?.output)) as Record<string, unknown>;
}
