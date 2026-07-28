/**
 * Forum 候选扫描器安全错误模型。
 */

const SAFE_MESSAGES = Object.freeze({
  NOT_DEVELOPMENT: "Forum 扫描仅允许在 development 环境运行。",
  TEST_MODE_REQUIRED: "Forum 扫描要求 TEST_MODE=true。",
  GUILD_CONFIRMATION_REQUIRED: "必须提供 --confirm-guild。",
  GUILD_CONFIRMATION_MISMATCH: "confirm-guild 与配置中的 DISCORD_GUILD_ID 不一致。",
  FORUM_REQUIRED: "必须至少提供一个 --forum。",
  INVALID_FORUM_ID: "Forum ID 不是合法的 Discord Snowflake。",
  INVALID_SILENCE_DAYS: "silence-days 必须为正有限数。",
  INVALID_DISPLAY_LIMIT: "display-limit 必须为正有限整数。",
  INVALID_EXCLUDED_TAG_ID: "exclude-tag 不是合法的 Discord Snowflake。",
  FORUM_NOT_FOUND: "目标 Forum 不存在或无法访问。",
  WRONG_GUILD: "目标 Forum 不属于确认的服务器。",
  NOT_FORUM_CHANNEL: "目标频道不是 GuildForum。",
  BOT_MISSING_VIEW_CHANNEL: "小G宝缺少查看目标 Forum 的权限。",
  ACTIVE_THREADS_FETCH_FAILED: "获取活跃 Thread 失败。",
  ARCHIVED_THREADS_FETCH_FAILED: "获取已归档 Thread 失败。",
  ARCHIVED_PAGINATION_STALLED: "已归档 Thread 分页卡住，无法继续。",
  ACTIVITY_TIME_INVALID: "无法计算 Thread 活动时间。",
  SCAN_FAILED: "Forum 扫描失败。",
  INVALID_ARGUMENT: "Forum 扫描参数无效。",
});

export class ForumBumpError extends Error {
  /**
   * @param {string} code
   * @param {string} [safeMessage]
   * @param {unknown} [cause]
   * @param {object|null} [context]
   */
  constructor(code, safeMessage = SAFE_MESSAGES[code] ?? "Forum 扫描失败。", cause, context = null) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ForumBumpError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
    this.context = context && typeof context === "object" ? { ...context } : null;
  }
}

export function isForumBumpError(error) {
  return error instanceof ForumBumpError;
}

export function createForumBumpError(code, cause, context = null) {
  return new ForumBumpError(code, SAFE_MESSAGES[code], cause, context);
}

export function getSafeMessage(code) {
  return SAFE_MESSAGES[code] ?? "Forum 扫描失败。";
}

export { SAFE_MESSAGES as FORUM_BUMP_SAFE_MESSAGES };
