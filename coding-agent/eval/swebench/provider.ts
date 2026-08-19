import OpenAI from "openai";

import type { Provider } from "../../config.ts";
import type { ResponsesClient } from "../../runtime/responses.ts";
import {
  createModelProxyHandler,
  type ModelProxyHandler,
} from "./model_proxy.ts";

export type ProviderClientFactory = (options: {
  apiKey: string;
  baseURL: string;
}) => ResponsesClient;

const defaultClientFactory: ProviderClientFactory = ({ apiKey, baseURL }) =>
  new OpenAI({ apiKey, baseURL }) as unknown as ResponsesClient;

/**
 * 宿主机复用当前配置的 provider；API key 只存在于这个客户端闭包里，
 * 不会进入 Docker 环境变量或 Worker 的 stdin 请求。
 */
export function createConfiguredModelProxy(
  provider: Provider,
  clientFactory: ProviderClientFactory = defaultClientFactory,
): ModelProxyHandler {
  const client = clientFactory({
    apiKey: provider.AGENT_API_KEY,
    baseURL: provider.base_url,
  });
  return createModelProxyHandler(client);
}
