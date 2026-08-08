/**
 * Manual Message Service 的内容与 Mention 策略。
 *
 * 保留管理员原始 Markdown / Unicode / Emoji，不做静默截断或清洗。
 */

import { createManualMessageError } from "./errors.js";

export const MAX_CONTENT_LENGTH = 2000;

/**
 * Discord 的内容限制按字符表达；使用 Unicode code point 计数，避免把一个
 * 代理对 Emoji 误算成两个可见字符。
 */
export function countContentCharacters(content) {
  return typeof content === "string" ? Array.from(content).length : 0;
}

/**
 * @param {unknown} content
 * @returns {{content: string, contentLength: number}}
 */
export function validateManualContent(content) {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw createManualMessageError("EMPTY_CONTENT");
  }

  const contentLength = countContentCharacters(content);
  if (contentLength > MAX_CONTENT_LENGTH) {
    throw createManualMessageError("CONTENT_TOO_LONG");
  }

  return {
    content,
    contentLength,
  };
}
