import type { ToolHandler } from "../../../../tools/registry.ts";

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
    chat: {
      completions: {
        create: async () => ({ choices: [{ ...choices.shift()! }] }),
      },
    },
  };
}

export const echoSpecs = [{
  type: "function" as const,
  function: { name: "echo", parameters: { type: "object" } },
}];

export const echoHandlers: Record<string, ToolHandler> = {
  echo: ({ text }) => ({ ok: true, data: { text }, error: null }),
};
