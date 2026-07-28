/**
 * Forum POC 安全业务错误模型。
 *
 * safeMessage 只用于对外展示；cause 仅内部诊断，不得原样输出。
 */

const SAFE_MESSAGES = Object.freeze({
  NOT_DEVELOPMENT: "Forum POC 仅允许在 development 环境运行。",
  TEST_MODE_REQUIRED: "Forum POC 要求 TEST_MODE=true。",
  GUILD_CONFIRMATION_REQUIRED: "必须提供 --confirm-guild。",
  GUILD_CONFIRMATION_MISMATCH: "confirm-guild 与配置中的 DISCORD_GUILD_ID 不一致。",
  WRONG_GUILD: "目标 Thread 不属于配置中的服务器。",
  THREAD_NOT_FOUND: "目标 Thread 不存在或无法访问。",
  WRONG_THREAD_TYPE: "目标频道类型不是 Forum 帖子（PublicThread）。",
  NOT_FORUM_THREAD: "目标 Thread 的父频道不是 GuildForum。",
  THREAD_LOCKED: "目标 Thread 已锁定，Forum POC 拒绝操作。",
  BOT_MISSING_PERMISSION: "小G宝缺少在目标 Thread 操作所需的权限。",
  SEND_FAILED: "发送临时顶帖消息失败。",
  DELETE_FAILED: "删除临时顶帖消息失败。",
  INSPECT_FAILED: "读取 Forum Thread 状态失败。",
  INVALID_ARGUMENT: "Forum POC 参数无效。",
  EXECUTE_REQUIRED: "真实写操作需要显式 --execute。",
});

export class ForumPocError extends Error {
  /**
   * @param {string} code
   * @param {string} [safeMessage]
   * @param {unknown} [cause]
   */
  constructor(code, safeMessage = SAFE_MESSAGES[code] ?? "Forum POC 操作失败。", cause) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ForumPocError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
  }
}

export function isForumPocError(error) {
  return error instanceof ForumPocError;
}

export function createForumPocError(code, cause) {
  return new ForumPocError(code, SAFE_MESSAGES[code], cause);
}

export function getSafeMessage(code) {
  return SAFE_MESSAGES[code] ?? "Forum POC 操作失败。";
}

export { SAFE_MESSAGES as FORUM_POC_SAFE_MESSAGES };
