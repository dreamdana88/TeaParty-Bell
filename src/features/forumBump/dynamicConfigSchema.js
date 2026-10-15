/**
 * Forum Bump 动态配置 schema v1。
 * 严格字段；未知字段拒绝；不保存历史。
 */

import { AppError } from "../../utils/appError.js";
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

/** 动态配置错误额外暴露 errorCode（= code），面板与 runtime 结果沿用该字段。 */
export class ForumBumpDynamicConfigError extends AppError {
  constructor(code, safeMessage = SAFE_MESSAGES[code] ?? "动态配置错误。", cause, context = null) {
    super(code, safeMessage, cause, context);
    this.name = "ForumBumpDynamicConfigError";
    this.errorCode = code;
  }
}

export function isForumBumpDynamicConfigError(error) {
  return error instanceof ForumBumpDynamicConfigError;
}

export function createDynamicConfigError(code, cause, context = null) {
  return new ForumBumpDynamicConfigError(code, SAFE_MESSAGES[code], cause, context);
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

  const invalid = (field) => createDynamicConfigError("DYNAMIC_CONFIG_INVALID", undefined, { field });

  if (!Number.isInteger(data.revision) || data.revision < 0) throw invalid("revision");
  // dailyLimit 整数范围粗检；与活跃窗关系由 computeAutoInterval 统一判定
  if (!Number.isInteger(data.dailyLimit) || data.dailyLimit < 1) throw invalid("dailyLimit");

  const start = parseHhMm(data.activeStart);
  if (!start) throw invalid("activeStart");
  const end = parseHhMm(data.activeEnd);
  if (!end) throw invalid("activeEnd");
  if (start.hour * 60 + start.minute >= end.hour * 60 + end.minute) throw invalid("activeWindow");

  if (!Array.isArray(data.forumChannelIds) || data.forumChannelIds.length === 0
    || ![...data.forumChannelIds].every(isDiscordSnowflake)) {
    throw invalid("forumChannelIds");
  }
  const forumChannelIds = [...new Set(data.forumChannelIds)];

  if (!Number.isInteger(data.silenceDays) || data.silenceDays < 1 || data.silenceDays > 3650) {
    throw invalid("silenceDays");
  }
  if (data.updatedAt !== null && !isValidIsoTimestamp(data.updatedAt)) throw invalid("updatedAt");
  if (data.updatedBy !== null && (typeof data.updatedBy !== "string"
    || data.updatedBy.trim().length === 0 || data.updatedBy.length > 200)) {
    throw invalid("updatedBy");
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
    updatedBy: data.updatedBy === null ? null : data.updatedBy.trim(),
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
