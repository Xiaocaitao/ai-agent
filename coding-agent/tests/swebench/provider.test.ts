import assert from "node:assert/strict";
import test from "node:test";

import {
  createConfiguredModelProxy,
  type ProviderClientFactory,
} from "../../eval/swebench/provider.ts";

test("configured provider stays on the host and never enters worker requests", async () => {
  let receivedOptions: { apiKey: string; baseURL: string } | undefined;
  let upstreamRequest: Record<string, unknown> | undefined;
  const factory: ProviderClientFactory = (options) => {
    receivedOptions = options;
    return {
      responses: {
        async create(request) {
          upstreamRequest = request;
          return {
            output: [],
            output_text: "host-provider-ok",
            status: "completed",
          };
        },
      },
    };
  };

  const proxy = createConfiguredModelProxy(
    {
      AGENT_API_KEY: "secret-must-stay-host",
      base_url: "https://api.deepseek.com",
      model: "deepseek-chat",
      context_window: 32_000,
    },
    factory,
  );

  const response = await proxy({ model: "deepseek-chat", stream: true });

  assert.deepEqual(receivedOptions, {
    apiKey: "secret-must-stay-host",
    baseURL: "https://api.deepseek.com",
  });
  assert.deepEqual(upstreamRequest, {
    model: "deepseek-chat",
    stream: false,
  });
  assert.equal(response.output_text, "host-provider-ok");
});
