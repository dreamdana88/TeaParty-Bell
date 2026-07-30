/**
 * OpenAI-compatible Provider 的安全错误类型。
 *
 * 错误文本刻意不携带请求头、请求体、API Key 或上游原始响应。
 */
export class AiProviderError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{ httpStatus?: number, backendLabel?: string, model?: string }} [opts]
   */
  constructor(message, code, opts = {}) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.backendLabel = opts.backendLabel;
    this.model = opts.model;
  }
}
