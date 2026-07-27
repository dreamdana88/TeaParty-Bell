/**
 * Manual Message Service 的安全业务错误模型。
 *
 * safeMessage 只用于对外展示；cause 保留给内部诊断，不能直接写入审计。
 */

export const MANUAL_MESSAGE_SOURCES = Object.freeze([
  "discord_slash",
  "discord_context_menu",
  "hermes",
]);

const SAFE_MESSAGES = Object.freeze({
  INVALID_SOURCE: "人工发言来源无效。",
  WRONG_GUILD: "只能在目标服务器发言。",
  CHANNEL_NOT_FOUND: "目标频道不存在或无法访问。",
  WRONG_CHANNEL_TYPE: "目标频道不是可发送的文字频道。",
  TARGET_MESSAGE_NOT_FOUND: "目标消息不存在或无法访问。",
  BOT_MISSING_PERMISSION: "小G宝缺少在目标频道发言所需的权限。",
  EMPTY_CONTENT: "发言内容不能为空。",
  CONTENT_TOO_LONG: "发言内容超过 2000 字符。",
  FORBIDDEN_MENTION: "发言内容不能包含 @everyone、@here 或角色 Mention。",
  TOO_MANY_USER_MENTIONS: "一次发言最多允许 10 个不同的用户 Mention。",
  THREAD_LOCKED: "目标 Thread 已锁定，无法发言。",
  SEND_FAILED: "小G宝发送消息失败。",
  REPLY_FAILED: "小G宝回复消息失败。",
});

export class ManualMessageError extends Error {
  /**
   * @param {string} code
   * @param {string} [safeMessage]
   * @param {unknown} [cause]
   */
  constructor(code, safeMessage = SAFE_MESSAGES[code] ?? "人工发言失败。", cause) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ManualMessageError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
  }
}

export function isManualMessageError(error) {
  return error instanceof ManualMessageError;
}

export function createManualMessageError(code, cause) {
  return new ManualMessageError(code, SAFE_MESSAGES[code], cause);
}

export function getSafeMessage(code) {
  return SAFE_MESSAGES[code] ?? "人工发言失败。";
}
