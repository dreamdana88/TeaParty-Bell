/**
 * DeepSeek AI Provider（Phase 4）。
 *
 * 基于 DeepSeek Chat Completions API（OpenAI 兼容格式）的轻量 AI 文本生成能力。
 * 使用 Node.js 原生 fetch，不引入第三方 SDK。
 *
 * 职责：
 * - 构造 API 请求
 * - 鉴权（Authorization Header）
 * - 模型选择
 * - Thinking Mode 控制
 * - 请求超时
 * - HTTP 错误处理
 * - API 返回结构校验
 * - 返回标准化最终 content（不含 reasoning_content）
 *
 * 不负责：
 * - 感谢文案 Prompt
 * - Discord 用户处理
 * - Boost 业务逻辑
 * - 消息发送
 */

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

/**
 * DeepSeek API 相关错误的统一类型。
 *
 * @property {string} code - 机器可读错误码，用于程序化判断
 * @property {number|undefined} httpStatus - HTTP 状态码（如有）
 */
export class DeepSeekError extends Error {
  /**
   * @param {string} message - 人类可读错误描述
   * @param {string} code - 错误码
   * @param {{ httpStatus?: number, cause?: Error }} [opts]
   */
  constructor(message, code, opts = {}) {
    super(message);
    this.name = "DeepSeekError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    if (opts.cause) {
      this.cause = opts.cause;
    }
  }
}

// ---------------------------------------------------------------------------
// Provider 工厂
// ---------------------------------------------------------------------------

/**
 * 创建 DeepSeek AI Provider。
 *
 * 缺少 DEEPSEEK_API_KEY 时仍返回可用对象，但调用 chat() 时将抛出明确错误。
 * 这允许 Discord 核心在无 AI Key 时正常启动，仅 AI 功能不可用。
 *
 * @param {object} config - 完整配置对象（来自 loadConfig()）
 * @param {string|undefined} config.deepseekApiKey
 * @param {string} config.deepseekBaseUrl
 * @param {string} config.deepseekModel
 * @param {number} config.deepseekTimeoutMs
 *
 * @returns {{ chat: Function, readonly model: string }}
 */
export function createDeepSeekProvider(config) {
  const apiKey = config.deepseekApiKey;
  const baseUrl = config.deepseekBaseUrl || "https://api.deepseek.com";
  const model = config.deepseekModel || "deepseek-v4-flash";
  const timeoutMs = config.deepseekTimeoutMs ?? 30000;

  // 规范化 baseUrl：去除末尾斜杠
  const base = baseUrl.replace(/\/+$/, "");

  /**
   * 调用 DeepSeek Chat Completions 生成文本。
   *
   * @param {Array<{ role: string, content: string }>} messages
   *   - role: "system" | "user" | "assistant"
   *   - content: 文本内容
   *
   * @param {object} [options]
   * @param {number} [options.maxTokens]        - 最大生成 token 数
   * @param {{ type: "enabled"|"disabled" }} [options.thinking]
   *   - 明确指定 thinking 模式；未指定时显式传 disabled（不依赖默认值）
   *
   * @returns {Promise<string>} 标准化、trim 后的最终文本
   * @throws {DeepSeekError} 所有错误均以 DeepSeekError 抛出
   */
  async function chat(messages, options = {}) {
    // ---- 1. API Key 检查 ----
    if (!apiKey) {
      throw new DeepSeekError(
        "DeepSeek API Key 未配置，AI 功能不可用。请在 .env 中设置 DEEPSEEK_API_KEY",
        "missing_api_key"
      );
    }

    // ---- 2. 构造请求体 ----
    const body = {
      model,
      messages,
    };

    // max_tokens（仅在明确传入时设置）
    if (options.maxTokens !== undefined && options.maxTokens !== null) {
      body.max_tokens = options.maxTokens;
    }

    // thinking 模式（必须明确指定，不依赖 DeepSeek 默认值）
    body.thinking = options.thinking ?? { type: "disabled" };

    // ---- 3. 构造请求 ----
    const url = `${base}/v1/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === "AbortError") {
        throw new DeepSeekError(
          `DeepSeek API 请求超时（${timeoutMs}ms）`,
          "timeout",
          { cause: err }
        );
      }
      throw new DeepSeekError(
        `DeepSeek API 网络请求失败：${err.message}`,
        "network_error",
        { cause: err }
      );
    } finally {
      clearTimeout(timer);
    }

    // ---- 4. HTTP 状态码处理 ----
    if (!response.ok) {
      const errorBody = await _safeReadBody(response);
      throw _httpError(response.status, errorBody);
    }

    // ---- 5. 解析响应 JSON ----
    let data;
    try {
      data = await response.json();
    } catch (err) {
      throw new DeepSeekError(
        "DeepSeek API 返回非 JSON 或解析失败",
        "invalid_response",
        { httpStatus: response.status, cause: err }
      );
    }

    // ---- 6. 结构校验 ----
    if (!data || typeof data !== "object") {
      throw new DeepSeekError(
        "DeepSeek API 返回结构异常（非对象）",
        "invalid_response"
      );
    }

    if (!Array.isArray(data.choices) || data.choices.length === 0) {
      throw new DeepSeekError(
        "DeepSeek API 返回结果中缺少 choices",
        "invalid_response"
      );
    }

    const choice = data.choices[0];
    if (!choice.message || typeof choice.message !== "object") {
      throw new DeepSeekError(
        "DeepSeek API 返回结果中 message 缺失",
        "invalid_response"
      );
    }

    // ---- 7. 提取最终 content（不使用 reasoning_content）----
    const content = choice.message.content;
    if (content === null || content === undefined || content === "") {
      const finishReason = choice.finish_reason ?? "unknown";
      throw new DeepSeekError(
        `DeepSeek API 返回的 content 为空（finish_reason: ${finishReason}）`,
        "empty_content"
      );
    }

    // ---- 8. 标准化返回 ----
    return String(content).trim();
  }

  return {
    chat,
    /** @readonly 当前使用的模型名 */
    get model() {
      return model;
    },
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 安全读取响应 body 文本（捕获异常，防止二次失败）。
 */
async function _safeReadBody(response) {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * 根据 HTTP 状态码构造对应的 DeepSeekError。
 *
 * @param {number} status
 * @param {string|null} body - 响应体文本
 * @returns {DeepSeekError}
 */
function _httpError(status, body) {
  // 提取服务端返回的错误信息（如有）
  let hint = "";
  try {
    if (body) {
      const parsed = JSON.parse(body);
      if (parsed.error?.message) {
        hint = ` — ${parsed.error.message}`;
      }
    }
  } catch {
    // body 非 JSON，忽略
  }

  switch (status) {
    case 401:
      return new DeepSeekError(
        `DeepSeek API 认证失败（401）：API Key 无效或未授权${hint}`,
        "auth_error",
        { httpStatus: status }
      );
    case 402:
      return new DeepSeekError(
        `DeepSeek API 余额不足（402）${hint}`,
        "insufficient_balance",
        { httpStatus: status }
      );
    case 422:
      return new DeepSeekError(
        `DeepSeek API 参数错误（422）${hint}`,
        "invalid_params",
        { httpStatus: status }
      );
    case 429:
      return new DeepSeekError(
        `DeepSeek API 请求过于频繁（429）${hint}`,
        "rate_limit",
        { httpStatus: status }
      );
    case 500:
      return new DeepSeekError(
        `DeepSeek 服务端错误（500）${hint}`,
        "server_error",
        { httpStatus: status }
      );
    case 503:
      return new DeepSeekError(
        `DeepSeek 服务过载（503）${hint}`,
        "server_overloaded",
        { httpStatus: status }
      );
    default:
      return new DeepSeekError(
        `DeepSeek API 返回未预期的 HTTP 状态码 ${status}${hint}`,
        "unknown_http_error",
        { httpStatus: status }
      );
  }
}
