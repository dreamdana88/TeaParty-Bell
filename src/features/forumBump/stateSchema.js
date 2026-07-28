/**
 * Forum Bump 状态 schema v1：创建与严格校验。
 * 未知顶层 / inFlight 字段一律拒绝。
 */

import { isDiscordSnowflake } from "./activityTime.js";

export const FORUM_BUMP_STATE_VERSION = 1;

export const FORUM_BUMP_STATE_PATH = "data/runtime/forum-bump/state.json";

export const INFLIGHT_PHASES = Object.freeze([
  "before_send",
  "after_send",
  "after_delete",
]);

const TOP_LEVEL_KEYS = Object.freeze([
  "version",
  "revision",
  "localDate",
  "successCount",
  "lastSuccessAt",
  "nextEligibleAt",
  "paused",
  "pauseReason",
  "inFlight",
]);

const INFLIGHT_KEYS = Object.freeze([
  "operationId",
  "guildId",
  "forumChannelId",
  "threadId",
  "phase",
  "sentMessageId",
  "startedAt",
  "updatedAt",
]);

const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SAFE_MESSAGES = Object.freeze({
  STATE_ARGUMENT_INVALID: "状态操作参数无效。",
  STATE_NOT_FOUND: "Forum Bump 状态文件不存在。",
  STATE_ALREADY_EXISTS: "Forum Bump 状态文件已存在，拒绝覆盖。",
  STATE_READ_FAILED: "读取 Forum Bump 状态文件失败。",
  STATE_PARSE_FAILED: "Forum Bump 状态文件 JSON 解析失败。",
  STATE_VERSION_UNSUPPORTED: "Forum Bump 状态文件版本不受支持。",
  STATE_INVALID: "Forum Bump 状态文件 schema 非法。",
  STATE_WRITE_FAILED: "写入 Forum Bump 状态文件失败。",
  STATE_REVISION_CONFLICT: "Forum Bump 状态 revision 冲突。",
  STATE_TRANSITION_INVALID: "Forum Bump 状态转换非法。",
  STATE_PAUSED: "Forum Bump 已暂停。",
  STATE_INFLIGHT_EXISTS: "已存在进行中的顶帖操作。",
  STATE_INFLIGHT_NOT_FOUND: "未找到进行中的顶帖操作。",
  STATE_INFLIGHT_MISMATCH: "顶帖操作标识不匹配。",
  STATE_RECOVERY_REQUIRED: "需要先完成崩溃恢复处理。",
  STATE_DATE_ROLLBACK: "业务日期不允许回退。",
});

export class ForumBumpStateError extends Error {
  /**
   * @param {string} code
   * @param {string} [safeMessage]
   * @param {unknown} [cause]
   * @param {object|null} [context]
   */
  constructor(code, safeMessage = SAFE_MESSAGES[code] ?? "Forum Bump 状态错误。", cause, context = null) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ForumBumpStateError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
    this.context = context && typeof context === "object" ? { ...context } : null;
  }
}

export function isForumBumpStateError(error) {
  return error instanceof ForumBumpStateError;
}

export function createStateError(code, cause, context = null) {
  return new ForumBumpStateError(code, SAFE_MESSAGES[code], cause, context);
}

export function getStateSafeMessage(code) {
  return SAFE_MESSAGES[code] ?? "Forum Bump 状态错误。";
}

/**
 * @param {string} localDate
 */
export function isValidLocalDate(localDate) {
  if (typeof localDate !== "string" || !LOCAL_DATE_RE.test(localDate)) return false;
  const [y, m, d] = localDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y
    && dt.getUTCMonth() === m - 1
    && dt.getUTCDate() === d;
}

/**
 * @param {unknown} value
 */
export function isValidIsoTimestamp(value) {
  if (typeof value !== "string" || value.length < 10) return false;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  // 要求可往返解析（接受带 Z 的 ISO）
  return true;
}

/**
 * @param {unknown} value
 */
export function isSafeNonNegativeInt(value) {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= Number.MAX_SAFE_INTEGER;
}

/**
 * @param {string} localDate
 */
export function createInitialState(localDate) {
  if (!isValidLocalDate(localDate)) {
    throw createStateError("STATE_ARGUMENT_INVALID", undefined, { operation: "createInitialState" });
  }
  return {
    version: FORUM_BUMP_STATE_VERSION,
    revision: 0,
    localDate,
    successCount: 0,
    lastSuccessAt: null,
    nextEligibleAt: null,
    paused: false,
    pauseReason: null,
    inFlight: null,
  };
}

/**
 * 深拷贝状态（仅 schema 字段）。
 * @param {object} state
 */
export function cloneState(state) {
  return {
    version: state.version,
    revision: state.revision,
    localDate: state.localDate,
    successCount: state.successCount,
    lastSuccessAt: state.lastSuccessAt,
    nextEligibleAt: state.nextEligibleAt,
    paused: state.paused,
    pauseReason: state.pauseReason,
    inFlight: state.inFlight
      ? {
        operationId: state.inFlight.operationId,
        guildId: state.inFlight.guildId,
        forumChannelId: state.inFlight.forumChannelId,
        threadId: state.inFlight.threadId,
        phase: state.inFlight.phase,
        sentMessageId: state.inFlight.sentMessageId,
        startedAt: state.inFlight.startedAt,
        updatedAt: state.inFlight.updatedAt,
      }
      : null,
  };
}

/**
 * @param {unknown} data
 * @returns {object} 校验通过的状态（新对象）
 */
export function validateState(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createStateError("STATE_INVALID");
  }

  const keys = Object.keys(data);
  for (const key of keys) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      throw createStateError("STATE_INVALID", undefined, { operation: "unknown_field" });
    }
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in data)) {
      throw createStateError("STATE_INVALID", undefined, { operation: "missing_field" });
    }
  }

  if (data.version !== FORUM_BUMP_STATE_VERSION) {
    if (typeof data.version === "number" && Number.isInteger(data.version) && data.version !== FORUM_BUMP_STATE_VERSION) {
      throw createStateError("STATE_VERSION_UNSUPPORTED");
    }
    throw createStateError("STATE_INVALID");
  }

  if (!isSafeNonNegativeInt(data.revision)) {
    throw createStateError("STATE_INVALID");
  }
  if (!isValidLocalDate(data.localDate)) {
    throw createStateError("STATE_INVALID");
  }
  if (!isSafeNonNegativeInt(data.successCount)) {
    throw createStateError("STATE_INVALID");
  }

  if (data.lastSuccessAt !== null && !isValidIsoTimestamp(data.lastSuccessAt)) {
    throw createStateError("STATE_INVALID");
  }
  if (data.nextEligibleAt !== null && !isValidIsoTimestamp(data.nextEligibleAt)) {
    throw createStateError("STATE_INVALID");
  }

  if (typeof data.paused !== "boolean") {
    throw createStateError("STATE_INVALID");
  }
  if (data.paused === false) {
    if (data.pauseReason !== null) {
      throw createStateError("STATE_INVALID");
    }
  } else if (typeof data.pauseReason !== "string" || data.pauseReason.trim().length === 0) {
    throw createStateError("STATE_INVALID");
  }

  if (data.inFlight !== null) {
    validateInFlight(data.inFlight);
  }

  return cloneState(data);
}

/**
 * @param {unknown} inflight
 */
export function validateInFlight(inflight) {
  if (!inflight || typeof inflight !== "object" || Array.isArray(inflight)) {
    throw createStateError("STATE_INVALID");
  }
  for (const key of Object.keys(inflight)) {
    if (!INFLIGHT_KEYS.includes(key)) {
      throw createStateError("STATE_INVALID");
    }
  }
  for (const key of INFLIGHT_KEYS) {
    if (!(key in inflight)) {
      throw createStateError("STATE_INVALID");
    }
  }

  if (typeof inflight.operationId !== "string" || inflight.operationId.trim().length === 0) {
    throw createStateError("STATE_INVALID");
  }
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(inflight.operationId)) {
    throw createStateError("STATE_INVALID");
  }
  if (!isDiscordSnowflake(inflight.guildId)
    || !isDiscordSnowflake(inflight.forumChannelId)
    || !isDiscordSnowflake(inflight.threadId)) {
    throw createStateError("STATE_INVALID");
  }
  if (!INFLIGHT_PHASES.includes(inflight.phase)) {
    throw createStateError("STATE_INVALID");
  }
  if (!isValidIsoTimestamp(inflight.startedAt) || !isValidIsoTimestamp(inflight.updatedAt)) {
    throw createStateError("STATE_INVALID");
  }

  if (inflight.phase === "before_send") {
    if (inflight.sentMessageId !== null) {
      throw createStateError("STATE_INVALID");
    }
  } else if (!isDiscordSnowflake(inflight.sentMessageId)) {
    throw createStateError("STATE_INVALID");
  }
}

export { SAFE_MESSAGES as FORUM_BUMP_STATE_SAFE_MESSAGES };
