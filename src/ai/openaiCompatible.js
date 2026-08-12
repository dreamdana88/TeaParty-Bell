/**
 * 通用 OpenAI-compatible Chat Completions Provider。
 *
 * 仅依赖 /chat/completions 的通用请求和响应格式，不识别具体服务商。
 * 默认面向推理模型：发送 reasoning_effort=high，且不主动限制 max_tokens。
 */
import { AiProviderError } from "./aiProviderError.js";

/** 上游错误文本安全截断长度（字符） */
const UPSTREAM_ERROR_MAX_LEN = 500;

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
      reasoning_effort: options.reasoningEffort ?? "high",
      stream: false,
      ...extraBody,
    };

    // 仅在调用方明确提供时发送；默认把输出预算交给上游模型 / Provider
    if (options.maxTokens !== undefined && options.maxTokens !== null) {
      body.max_tokens = options.maxTokens;
    }
    if (options.temperature !== undefined && options.temperature !== null) {
      body.temperature = options.temperature;
    }

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
        const upstreamError = await safeReadUpstreamError(response);
        throw providerError(
          formatHttpErrorMessage(response.status, upstreamError),
          httpErrorCode(response.status),
          { httpStatus: response.status, upstreamError },
        );
      }

      const data = await response.json();
      const parsed = parseCompletion(data);

      if (!parsed.content) {
        if (parsed.hasReasoningContent && parsed.finishReason === "length") {
          throw providerError(
            "模型在推理阶段耗尽输出预算，尚未生成最终正文",
            "reasoning_budget_exhausted",
            {
              httpStatus: response.status,
              finishReason: parsed.finishReason,
              hasReasoningContent: true,
              reasoningContentLength: parsed.reasoningContentLength,
              usage: parsed.usage,
            },
          );
        }
        throw providerError("AI Provider 返回的文本内容为空", "empty_content", {
          httpStatus: response.status,
          finishReason: parsed.finishReason,
          hasReasoningContent: parsed.hasReasoningContent,
          reasoningContentLength: parsed.reasoningContentLength,
          usage: parsed.usage,
        });
      }

      // 业务正文只返回 content；reasoning_content 仅作元数据诊断，不回传
      return parsed.content;
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

/**
 * 解析 Chat Completions 响应。
 * 只抽取最终 content 与安全诊断元数据，绝不返回 reasoning 原文。
 * @param {unknown} data
 */
function parseCompletion(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new AiProviderError("AI Provider 返回结构异常", "invalid_response");
  }
  if (!Array.isArray(data.choices) || data.choices.length === 0) {
    throw new AiProviderError("AI Provider 返回结果中缺少 choices", "invalid_response");
  }

  const choice = data.choices[0];
  const message = choice?.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new AiProviderError("AI Provider 返回结果中缺少 message content", "invalid_response");
  }

  const content = extractMessageText(message);
  const reasoningMeta = inspectReasoningContent(message.reasoning_content);
  const finishReason =
    typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  return {
    content,
    finishReason,
    hasReasoningContent: reasoningMeta.present,
    reasoningContentLength: reasoningMeta.length,
    usage: sanitizeUsage(data.usage),
  };
}

/**
 * @param {{ content?: unknown }} message
 * @returns {string}
 */
function extractMessageText(message) {
  const { content } = message;
  if (typeof content === "string") return content.trim();
  if (content == null) return "";
  if (!Array.isArray(content)) {
    throw new AiProviderError("AI Provider 返回结果中缺少 message content", "invalid_response");
  }

  return content
    .filter(
      (part) =>
        part &&
        typeof part === "object" &&
        part.type === "text" &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
}

/**
 * 仅检查 reasoning_content 是否存在及长度，不保留原文。
 * @param {unknown} value
 * @returns {{ present: boolean, length: number }}
 */
function inspectReasoningContent(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return { present: trimmed.length > 0, length: trimmed.length };
  }
  if (Array.isArray(value)) {
    let length = 0;
    let present = false;
    for (const part of value) {
      if (typeof part === "string") {
        const n = part.trim().length;
        if (n > 0) {
          present = true;
          length += n;
        }
      } else if (part && typeof part === "object" && typeof part.text === "string") {
        const n = part.text.trim().length;
        if (n > 0) {
          present = true;
          length += n;
        }
      }
    }
    return { present, length };
  }
  return { present: false, length: 0 };
}

/**
 * 只保留常见、无敏感信息的 usage 数字字段。
 * @param {unknown} usage
 * @returns {Record<string, number>|undefined}
 */
function sanitizeUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "reasoning_tokens"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  const details = usage.completion_tokens_details;
  if (details && typeof details === "object" && !Array.isArray(details)) {
    const rt = details.reasoning_tokens;
    if (typeof rt === "number" && Number.isFinite(rt)) {
      out.reasoning_tokens = rt;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 安全读取 4xx/5xx JSON 错误体，只提取受限字段。
 * 禁止记录 Authorization / 完整 Header / 完整未知响应体 / 任何 credential。
 * @param {Response} response
 * @returns {Promise<{ type?: string, code?: string, param?: string, message?: string }|null>}
 */
async function safeReadUpstreamError(response) {
  try {
    if (typeof response.json !== "function") return null;
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;

    const err =
      data.error && typeof data.error === "object" && !Array.isArray(data.error)
        ? data.error
        : data;

    /** @type {{ type?: string, code?: string, param?: string, message?: string }} */
    const result = {};
    const type = asNonEmptyString(err.type);
    const code = err.code != null ? asNonEmptyString(String(err.code)) : null;
    const param = asNonEmptyString(err.param);
    const message =
      asNonEmptyString(err.message) ?? asNonEmptyString(err.detail);

    if (type) result.type = truncate(type, UPSTREAM_ERROR_MAX_LEN);
    if (code) result.code = truncate(code, UPSTREAM_ERROR_MAX_LEN);
    if (param) result.param = truncate(param, UPSTREAM_ERROR_MAX_LEN);
    if (message) result.message = truncate(message, UPSTREAM_ERROR_MAX_LEN);

    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    // timeout 覆盖完整生命周期（含错误正文读取）；AbortError 必须继续向外抛
    if (error?.name === "AbortError") {
      throw error;
    }
    return null;
  }
}

/**
 * @param {number} status
 * @param {{ type?: string, code?: string, param?: string, message?: string }|null} upstream
 */
function formatHttpErrorMessage(status, upstream) {
  if (!upstream) {
    return `AI Provider 请求失败（HTTP ${status}）`;
  }
  const parts = [];
  if (upstream.type) parts.push(`type=${upstream.type}`);
  if (upstream.code) parts.push(`code=${upstream.code}`);
  if (upstream.param) parts.push(`param=${upstream.param}`);
  if (upstream.message) parts.push(upstream.message);
  const detail = truncate(parts.join(" "), UPSTREAM_ERROR_MAX_LEN);
  return detail
    ? `AI Provider 请求失败（HTTP ${status}）：${detail}`
    : `AI Provider 请求失败（HTTP ${status}）`;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function asNonEmptyString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * @param {string} text
 * @param {number} maxLen
 */
function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen);
}

function httpErrorCode(status) {
  if (status === 401 || status === 403) return "auth_error";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server_error";
  return "http_error";
}
