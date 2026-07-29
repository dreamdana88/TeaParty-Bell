/**
 * Forum Bump 动态配置 schema v1。
 * 严格字段；未知字段拒绝；不保存历史。
 */

import { isDiscordSnowflake } from "./activityTime.js";
import { parseHhMm } from "./schedulerConfig.js";
import { computeAutoInterval } from "./autoInterval.js";
import { isValidIsoTimestamp } from "./stateSchema.js";

export const FORUM_BUMP_DYNAMIC_CONFIG_VERSION = 1;
export const FORUM_BUMP_DYNAMIC_CONFIG_PATH = "data/runtime/forum-bump/config.json";

export const DYNAMIC_CONFIG_TOP_LEVEL_KEYS = Object.freeze([
  "version",
  "revision",
  "dailyLimit",
  "activeStart",
  "activeEnd",
  "forumChannelIds",
  "silenceDays",
  "updatedAt",
  "updatedBy",
]);

const SAFE_MESSAGES = Object.freeze({
  DYNAMIC_CONFIG_NOT_FOUND: "Forum Bump 动态配置文件不存在。",
  DYNAMIC_CONFIG_READ_FAILED: "读取 Forum Bump 动态配置失败。",
  DYNAMIC_CONFIG_PARSE_FAILED: "Forum Bump 动态配置 JSON 解析失败。",
  DYNAMIC_CONFIG_INVALID: "Forum Bump 动态配置 schema 非法。",
  DYNAMIC_CONFIG_VERSION_UNSUPPORTED: "Forum Bump 动态配置版本不受支持。",
  DYNAMIC_CONFIG_WRITE_FAILED: "写入 Forum Bump 动态配置失败。",
  DYNAMIC_CONFIG_REVISION_CONFLICT: "Forum Bump 动态配置 revision 冲突。",
  DYNAMIC_CONFIG_INTERVAL_TOO_SHORT: "自动顶帖间隔低于最短 30 分钟。",
  DYNAMIC_CONFIG_INTERVAL_INVALID: "无法计算自动顶帖间隔。",
  DYNAMIC_CONFIG_ARGUMENT_INVALID: "动态配置参数无效。",
  DYNAMIC_CONFIG_INFLIGHT_BLOCKED: "存在未完成 inFlight，拒绝更新配置。",
  DYNAMIC_CONFIG_PREFLIGHT_FAILED: "新增 Forum Preflight 失败。",
  DYNAMIC_CONFIG_UPDATE_FAILED: "配置热更新失败，已保留旧配置。",
  DYNAMIC_CONFIG_BUSY: "配置控制操作进行中。",
});

export class ForumBumpDynamicConfigError extends Error {
  /**
   * @param {string} code
   * @param {string} [safeMessage]
   * @param {unknown} [cause]
   * @param {object|null} [context]
   */
  constructor(code, safeMessage = SAFE_MESSAGES[code] ?? "动态配置错误。", cause, context = null) {
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ForumBumpDynamicConfigError";
    this.code = code;
    this.errorCode = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
    this.context = context && typeof context === "object" ? { ...context } : null;
  }
}

export function isForumBumpDynamicConfigError(error) {
  return error instanceof ForumBumpDynamicConfigError;
}

export function createDynamicConfigError(code, cause, context = null) {
  return new ForumBumpDynamicConfigError(
    code,
    SAFE_MESSAGES[code],
    cause,
    context,
  );
}

/**
 * @param {object} input
 * @returns {object}
 */
export function createDynamicConfigDocument({
  dailyLimit,
  activeStart,
  activeEnd,
  forumChannelIds,
  silenceDays,
  updatedAt = null,
  updatedBy = null,
  revision = 0,
} = {}) {
  return {
    version: FORUM_BUMP_DYNAMIC_CONFIG_VERSION,
    revision,
    dailyLimit,
    activeStart,
    activeEnd,
    forumChannelIds: [...forumChannelIds],
    silenceDays,
    updatedAt,
    updatedBy,
  };
}

/**
 * 从已校验 .env / 部署配置构造动态配置基线（内存，未必落盘）。
 * @param {object} forumBump
 */
export function baselineDynamicConfigFromEnv(forumBump, { updatedAt = null } = {}) {
  return createDynamicConfigDocument({
    dailyLimit: forumBump.dailyLimit,
    activeStart: forumBump.activeStart,
    activeEnd: forumBump.activeEnd,
    forumChannelIds: forumBump.forumChannelIds,
    silenceDays: forumBump.silenceDays,
    updatedAt,
    updatedBy: null,
    revision: 0,
  });
}

/**
 * 严格校验动态配置文档。
 * @param {unknown} data
 * @returns {object} 规范化副本
 */
export function validateDynamicConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID");
  }

  const keys = Object.keys(data);
  for (const k of keys) {
    if (!DYNAMIC_CONFIG_TOP_LEVEL_KEYS.includes(k)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
        unknownField: k,
      });
    }
  }
  for (const required of DYNAMIC_CONFIG_TOP_LEVEL_KEYS) {
    if (!(required in data)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
        missingField: required,
      });
    }
  }

  if (data.version !== FORUM_BUMP_DYNAMIC_CONFIG_VERSION) {
    if (typeof data.version === "number") {
      throw createDynamicConfigError("DYNAMIC_CONFIG_VERSION_UNSUPPORTED");
    }
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID");
  }

  if (!Number.isInteger(data.revision) || data.revision < 0) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "revision",
    });
  }

  if (!Number.isInteger(data.dailyLimit) || data.dailyLimit < 1 || data.dailyLimit > 10) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "dailyLimit",
    });
  }

  if (typeof data.activeStart !== "string" || !parseHhMm(data.activeStart)) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "activeStart",
    });
  }
  if (typeof data.activeEnd !== "string" || !parseHhMm(data.activeEnd)) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "activeEnd",
    });
  }
  const start = parseHhMm(data.activeStart);
  const end = parseHhMm(data.activeEnd);
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  if (startMin >= endMin) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "activeWindow",
    });
  }

  if (!Array.isArray(data.forumChannelIds) || data.forumChannelIds.length === 0) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "forumChannelIds",
    });
  }
  const forumChannelIds = [];
  const seen = new Set();
  for (const id of data.forumChannelIds) {
    if (typeof id !== "string" || !isDiscordSnowflake(id)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
        field: "forumChannelIds",
      });
    }
    if (seen.has(id)) continue;
    seen.add(id);
    forumChannelIds.push(id);
  }
  if (forumChannelIds.length === 0) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "forumChannelIds",
    });
  }

  if (!Number.isInteger(data.silenceDays) || data.silenceDays < 1 || data.silenceDays > 3650) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
      field: "silenceDays",
    });
  }

  if (data.updatedAt !== null) {
    if (typeof data.updatedAt !== "string" || !isValidIsoTimestamp(data.updatedAt)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
        field: "updatedAt",
      });
    }
  }

  if (data.updatedBy !== null) {
    if (typeof data.updatedBy !== "string" || data.updatedBy.trim().length === 0) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
        field: "updatedBy",
      });
    }
    if (data.updatedBy.length > 200) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, {
        field: "updatedBy",
      });
    }
  }

  const interval = computeAutoInterval(data.activeStart, data.activeEnd, data.dailyLimit);
  if (!interval.ok) {
    throw new ForumBumpDynamicConfigError(
      interval.errorCode,
      interval.safeMessage,
      undefined,
      { windowMinutes: interval.windowMinutes, exactMinutes: interval.exactMinutes },
    );
  }

  return {
    version: FORUM_BUMP_DYNAMIC_CONFIG_VERSION,
    revision: data.revision,
    dailyLimit: data.dailyLimit,
    activeStart: data.activeStart,
    activeEnd: data.activeEnd,
    forumChannelIds,
    silenceDays: data.silenceDays,
    updatedAt: data.updatedAt,
    updatedBy: data.updatedBy === null ? null : String(data.updatedBy).trim(),
  };
}

/**
 * 合并 patch 后校验（不递增 revision）。
 * @param {object} current 已校验文档
 * @param {object} patch
 */
export function mergeDynamicConfigPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw createDynamicConfigError("DYNAMIC_CONFIG_ARGUMENT_INVALID");
  }
  const allowed = new Set([
    "dailyLimit",
    "activeStart",
    "activeEnd",
    "forumChannelIds",
    "silenceDays",
  ]);
  for (const k of Object.keys(patch)) {
    if (!allowed.has(k)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_ARGUMENT_INVALID", undefined, {
        unknownField: k,
      });
    }
  }

  const merged = {
    ...current,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    ),
  };
  // revision / version / updated* 由 store 写入时设置
  return validateDynamicConfig({
    version: FORUM_BUMP_DYNAMIC_CONFIG_VERSION,
    revision: current.revision,
    dailyLimit: merged.dailyLimit,
    activeStart: merged.activeStart,
    activeEnd: merged.activeEnd,
    forumChannelIds: merged.forumChannelIds,
    silenceDays: merged.silenceDays,
    updatedAt: current.updatedAt,
    updatedBy: current.updatedBy,
  });
}

export function cloneDynamicConfig(doc) {
  return {
    ...doc,
    forumChannelIds: [...doc.forumChannelIds],
  };
}

export { SAFE_MESSAGES as DYNAMIC_CONFIG_SAFE_MESSAGES };
