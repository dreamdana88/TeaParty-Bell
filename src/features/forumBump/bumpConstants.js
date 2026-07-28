/**
 * 生产级单帖顶帖固定常量。
 * 调用方不得通过 bumpThread 参数覆盖。
 */

/** 生产候选固定文案（日志只记 contentLength）。 */
export const FORUM_BUMP_CONTENT = "〖小G宝自动顶帖〗此消息将自动删除。";

export const FORUM_BUMP_CONTENT_LENGTH = [...FORUM_BUMP_CONTENT].length;

/** 发送后删除前固定等待（毫秒）。 */
export const FORUM_BUMP_DELETE_DELAY_MS = 1000;

/** 删除后采集 afterDelete 前固定等待（毫秒）。 */
export const FORUM_BUMP_AFTER_DELETE_SETTLE_MS = 1000;

/** 严格禁止一切 mention 解析。 */
export const FORUM_BUMP_ALLOWED_MENTIONS = Object.freeze({
  parse: Object.freeze([]),
  users: Object.freeze([]),
  roles: Object.freeze([]),
  repliedUser: false,
});
