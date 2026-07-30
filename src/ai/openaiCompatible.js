/**
 * 通用 OpenAI-compatible Chat Completions Provider。
 *
 * 仅依赖 /chat/completions 的通用请求和响应格式，不识别具体服务商。
 */
import { AiProviderError } from "./aiProviderError.js";

/**
 * @param {object} config
 * @param {string} config.aiChatCompletionsUrl
 * @param {string} config.aiModel
 * @param {number} config.aiTimeoutMs
 * @param {string} config.aiBackendLabel
 * @param {string|undefined} config.aiApiKey
 * @param {string} config.aiAuthHeader
 * @param {string} config.aiAuthScheme
 * @param {Record<string, string>} [config.aiExtraHeaders]
 * @param {Record<string, unknown>} [config.aiExtraBody]
 * @param {{ fetchImpl?: typeof fetch, setTimeoutImpl?: typeof setTimeout, clearTimeoutImpl?: typeof clearTimeout }} [dependencies]
 */
export function createOpenAICompatibleProvider(config, dependencies = {}) {
  const endpoint = config.aiChatCompletionsUrl;
  const model = config.aiModel;
  const timeoutMs = config.aiTimeoutMs ?? 30000;
  const backendLabel = config.aiBackendLabel || "OpenAI Compatible";
  const apiKey = config.aiApiKey;
  const requireApiKey = config.aiRequireApiKey === true;
  const authHeader = config.aiAuthHeader || "Authorization";
  const authScheme = config.aiAuthScheme ?? "Bearer";
  const extraHeaders = config.aiExtraHeaders ?? {};
  const extraBody = config.aiExtraBody ?? {};
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const setTimeoutImpl = dependencies.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl ?? clearTimeout;

  if (typeof fetchImpl !== "function") {
    throw new AiProviderError("AI Provider 不可用：fetch 未提供", "fetch_unavailable", {
      backendLabel,
      model,
    });
  }

  async function chat(messages, options = {}) {
    if (!apiKey && requireApiKey) {
      throw providerError("AI Provider API Key 未配置", "missing_api_key");
    }
    const body = {
      model,
      messages,
      max_tokens: options.maxTokens ?? 128,
      temperature: 1,
      stream: false,
      ...extraBody,
    };
    const headers = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };

    if (apiKey) {
      headers[authHeader] = authScheme ? `${authScheme} ${apiKey}` : apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw providerError(
          `AI Provider 请求失败（HTTP ${response.status}）`,
          httpErrorCode(response.status),
          { httpStatus: response.status },
        );
      }

      const data = await response.json();
      const text = extractContent(data);
      if (!text) {
        throw providerError("AI Provider 返回的文本内容为空", "empty_content", {
          httpStatus: response.status,
        });
      }
      return text;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw providerError(`AI Provider 请求超时（${timeoutMs}ms）`, "timeout");
      }
      if (error instanceof AiProviderError) throw error;
      if (response) {
        throw providerError("AI Provider 返回非 JSON 或解析失败", "invalid_response", {
          httpStatus: response.status,
        });
      }
      throw providerError("AI Provider 网络请求失败", "network_error");
    } finally {
      clearTimeoutImpl(timer);
    }
  }

  function providerError(message, code, options = {}) {
    return new AiProviderError(message, code, {
      ...options,
      backendLabel,
      model,
    });
  }

  return {
    chat,
    get model() {
      return model;
    },
    get endpoint() {
      return endpoint;
    },
  };
}

function extractContent(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AiProviderError("AI Provider 返回结构异常", "invalid_response");
  }
  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    throw new AiProviderError("AI Provider 返回结果中缺少 choices", "invalid_response");
  }
  const message = data.choices[0]?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AiProviderError("AI Provider 返回结果中缺少 message content", "invalid_response");
  }

  const { content } = message;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) {
    throw new AiProviderError("AI Provider 返回结果中缺少 message content", "invalid_response");
  }

  const text = content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  return text;
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  return "http_error";
}
