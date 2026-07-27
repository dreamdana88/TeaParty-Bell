/**
 * Manual Message Service 的内容与 Mention 策略。
 *
 * 保留管理员原始 Markdown / Unicode / Emoji，不做静默截断或清洗。
 */

import { createManualMessageError } from "./errors.js";

export const MAX_CONTENT_LENGTH = 2000;
export const MAX_USER_MENTIONS = 10;

const EVERYONE_MENTION_PATTERN = /@everyone\b/i;
const HERE_MENTION_PATTERN = /@here\b/i;
const ROLE_MENTION_PATTERN = /<@&\d+>/;
const USER_MENTION_PATTERN = /<@!?(\d+)>/g;

/**
 * Discord 的内容限制按字符表达；使用 Unicode code point 计数，避免把一个
 * 代理对 Emoji 误算成两个可见字符。
 */
export function countContentCharacters(content) {
  return typeof content === "string" ? Array.from(content).length : 0;
}

export function extractUserMentionIds(content) {
  const ids = [];
  const seen = new Set();
  const pattern = new RegExp(USER_MENTION_PATTERN.source, "g");
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const id = match[1];
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function buildAllowedMentions(userIds) {
  return {
    parse: [],
    users: [...userIds],
    roles: [],
    repliedUser: false,
  };
}

/**
 * @param {unknown} content
 * @returns {{content: string, contentLength: number, userMentionIds: string[], allowedMentions: object}}
 */
export function validateManualContent(content) {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw createManualMessageError("EMPTY_CONTENT");
  }

  const contentLength = countContentCharacters(content);
  if (contentLength > MAX_CONTENT_LENGTH) {
    throw createManualMessageError("CONTENT_TOO_LONG");
  }

  if (
    EVERYONE_MENTION_PATTERN.test(content) ||
    HERE_MENTION_PATTERN.test(content) ||
    ROLE_MENTION_PATTERN.test(content)
  ) {
    throw createManualMessageError("FORBIDDEN_MENTION");
  }

  const userMentionIds = extractUserMentionIds(content);
  if (userMentionIds.length > MAX_USER_MENTIONS) {
    throw createManualMessageError("TOO_MANY_USER_MENTIONS");
  }

  return {
    content,
    contentLength,
    userMentionIds,
    allowedMentions: buildAllowedMentions(userMentionIds),
  };
}
