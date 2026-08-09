import type { ToolHandler } from "../../../../tools/registry.ts";
import { responseForRequest } from "../../../support/responses.ts";

export function toolCall(text: string, id: string) {
  return {
    id,
    type: "function" as const,
    function: { name: "echo", arguments: JSON.stringify({ text }) },
  };
}

export function message(content: string | null = null, toolCalls: ReturnType<typeof toolCall>[] = []) {
  return { content, tool_calls: toolCalls };
}

export function choice(messageValue: ReturnType<typeof message>, finishReason: string | null) {
  return { message: messageValue, finish_reason: finishReason };
}

export function fakeClient(...choices: ReturnType<typeof choice>[]) {
  return {
    responses: {
      create: async (request: unknown) => {
        const current = choices.shift()!;
        return responseForRequest(request, {
          output: [
            ...(current.message.tool_calls ?? []).map((call) => ({
              type: "function_call" as const,
              call_id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            })),
            ...(current.message.content === null ? [] : [{
              id: "message-1",
              type: "message" as const,
              role: "assistant" as const,
              status: "completed" as const,
              content: [{
                type: "output_text" as const,
                text: current.message.content,
                annotations: [],
                logprobs: [],
              }],
            }]),
          ],
          output_text: current.message.content ?? "",
          status: "completed" as const,
        });
      },
    },
  };
}

export const echoSpecs = [{
  type: "function" as const,
  name: "echo",
  parameters: { type: "object" },
  strict: false,
}];

export const echoHandlers: Record<string, ToolHandler> = {
  echo: ({ text }) => ({ ok: true, data: { text }, error: null }),
};
