import {
  isResponseEventStream,
  type ModelResponse,
  type ResponseEventStream,
  type ResponsesClient,
} from "../../runtime/responses.ts";

export type ModelRequestMessage = {
  type: "model_request";
  request: Record<string, unknown>;
};

export type ModelResponseMessage = {
  type: "model_response";
  ok: true;
  response: ModelResponse;
};

export type ModelErrorMessage = {
  type: "model_response";
  ok: false;
  error: string;
};

export type ModelProxyMessage =
  | ModelRequestMessage
  | ModelResponseMessage
  | ModelErrorMessage;

export type ModelProxyHandler = (
  request: Record<string, unknown>,
) => Promise<ModelResponse>;

async function terminalResponse(
  value: ModelResponse | ResponseEventStream,
): Promise<ModelResponse> {
  if (!isResponseEventStream(value)) return value;
  for await (const event of value) {
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      return event.response;
    }
  }
  throw new Error("模型流结束时未收到终止事件");
}

/** 宿主机调用当前 provider，Worker 永远只拿到序列化后的模型响应。 */
export function createModelProxyHandler(
  client: ResponsesClient,
): ModelProxyHandler {
  return async (request) =>
    terminalResponse(await client.responses.create({ ...request, stream: false }));
}

function parseModelResponseMessage(
  line: string,
): ModelResponseMessage | ModelErrorMessage {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("模型代理响应不是合法 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("模型代理响应格式非法");
  }
  const message = value as Record<string, unknown>;
  if (message.type !== "model_response" || typeof message.ok !== "boolean") {
    throw new Error("模型代理响应类型非法");
  }
  if (message.ok === false) {
    return {
      type: "model_response",
      ok: false,
      error: String(message.error ?? "模型代理失败"),
    };
  }
  if (message.response === undefined) throw new Error("模型代理响应缺少 response");
  return {
    type: "model_response",
    ok: true,
    response: message.response as ModelResponse,
  };
}

export function createStdioResponsesClient(options: {
  send: (message: ModelRequestMessage) => void;
  receive: () => Promise<string>;
}): ResponsesClient {
  return {
    responses: {
      async create(request) {
        options.send({ type: "model_request", request });
        const response = parseModelResponseMessage(await options.receive());
        if (response.ok === false) throw new Error(response.error);
        if (request.stream !== true) return response.response;
        return (async function* (): AsyncGenerator<never> {
          yield {
            type: "response.completed",
            response: response.response,
            sequence_number: 1,
          } as never;
        })();
      },
    },
  };
}
