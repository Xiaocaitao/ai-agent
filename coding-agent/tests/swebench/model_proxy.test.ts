import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelProxyHandler,
  createStdioResponsesClient,
} from "../../eval/swebench/model_proxy.ts";
import {
  consumeResponseStream,
  isResponseEventStream,
  type ResponsesClient,
} from "../../runtime/responses.ts";

function modelResponse() {
  return {
    output: [],
    output_text: "proxy-ok",
    status: "completed" as const,
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
  };
}

test("stdio 模型代理把 Worker 请求转发给宿主机 provider", async () => {
  const requests: Record<string, unknown>[] = [];
  const upstream: ResponsesClient = {
    responses: {
      create: async (request) => {
        requests.push(request);
        return modelResponse();
      },
    },
  };
  const proxy = createModelProxyHandler(upstream);
  const messages: string[] = [];
  const client = createStdioResponsesClient({
    send: (message) => {
      messages.push(JSON.stringify(message));
    },
    receive: async () => {
      const request = JSON.parse(messages.at(-1)!) as { request: Record<string, unknown> };
      const response = await proxy(request.request);
      return JSON.stringify({ type: "model_response", ok: true, response });
    },
  });

  const streamed = await client.responses.create({
    model: "deepseek-test",
    input: "hello",
    stream: true,
  });
  assert.equal(isResponseEventStream(streamed), true);
  if (!isResponseEventStream(streamed)) throw new Error("expected stream");
  const completed = await consumeResponseStream(streamed, () => undefined);
  assert.equal(completed.output_text, "proxy-ok");

  const nonStreamed = await client.responses.create({
    model: "deepseek-test",
    input: "hello again",
  });
  assert.equal(isResponseEventStream(nonStreamed), false);
  if (isResponseEventStream(nonStreamed)) throw new Error("unexpected stream");
  assert.equal(nonStreamed.output_text, "proxy-ok");
  assert.deepEqual(requests.map((request) => request.stream), [false, false]);
});
