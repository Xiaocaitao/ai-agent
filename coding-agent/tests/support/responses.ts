import type { ResponseStreamEvent } from "openai/resources/responses/responses";

import type {
  ModelResponse,
  ResponseEventStream,
} from "../../runtime/responses.ts";

export function responseForRequest(
  request: unknown,
  response: ModelResponse,
): ModelResponse | ResponseEventStream {
  if (
    typeof request !== "object" ||
    request === null ||
    !("stream" in request) ||
    request.stream !== true
  ) {
    return response;
  }

  return (async function* (): AsyncGenerator<ResponseStreamEvent> {
    const type = response.status === "failed"
      ? "response.failed"
      : response.status === "incomplete"
      ? "response.incomplete"
      : "response.completed";
    yield {
      type,
      response,
      sequence_number: 1,
    } as ResponseStreamEvent;
  })();
}
