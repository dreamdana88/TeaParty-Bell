/**
 * OpenAI-compatible Provider 的安全错误类型。
 *
 * 错误文本刻意不携带请求头、请求体、API Key、reasoning 原文或上游完整响应。
 */
export class AiProviderError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {{
   *   httpStatus?: number,
   *   backendLabel?: string,
   *   model?: string,
   *   finishReason?: string,
   *   hasReasoningContent?: boolean,
   *   reasoningContentLength?: number,
   *   usage?: Record<string, number>,
   *   upstreamError?: { type?: string, code?: string, param?: string, message?: string }|null,
   * }} [opts]
   */
  constructor(message, code, opts = {}) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.backendLabel = opts.backendLabel;
    this.model = opts.model;

    // 可选诊断字段：仅元数据，不含 reasoning 原文或凭证
    if (opts.finishReason !== undefined) {
      this.finishReason = opts.finishReason;
    }
    if (opts.hasReasoningContent !== undefined) {
      this.hasReasoningContent = opts.hasReasoningContent;
    }
    if (opts.reasoningContentLength !== undefined) {
      this.reasoningContentLength = opts.reasoningContentLength;
    }
    if (opts.usage !== undefined) {
      this.usage = opts.usage;
    }
    if (opts.upstreamError !== undefined) {
      this.upstreamError = opts.upstreamError;
    }
  }
}
