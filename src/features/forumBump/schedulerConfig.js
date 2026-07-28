/**
 * Forum Bump 调度器配置校验（纯函数）。
 */

import { isDiscordSnowflake } from "./activityTime.js";

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class SchedulerConfigError extends Error {
  constructor(code, safeMessage, context = null) {
    super(safeMessage);
    this.name = "SchedulerConfigError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.context = context;
  }
}

/**
 * @param {unknown} timezone
 */
export function isValidIanaTimezone(timezone) {
  if (typeof timezone !== "string" || timezone.trim().length === 0) return false;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} hhmm
 * @returns {{ hour: number, minute: number }|null}
 */
export function parseHhMm(hhmm) {
  if (typeof hhmm !== "string" || !TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return { hour: h, minute: m };
}

function isSafePositiveInt(n) {
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER;
}

function isSafeNonNegInt(n) {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
}

/**
 * @param {object} config
 * @returns {object} 规范化配置
 */
export function validateSchedulerConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "调度配置必须为对象。");
  }

  if (typeof config.enabled !== "boolean") {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "enabled 必须为 boolean。");
  }
  if (!isDiscordSnowflake(config.guildId)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "guildId 非法。");
  }
  if (!Array.isArray(config.forumChannelIds) || config.forumChannelIds.length === 0) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "forumChannelIds 不能为空。");
  }

  const forumChannelIds = [];
  const seen = new Set();
  for (const id of config.forumChannelIds) {
    if (!isDiscordSnowflake(id)) {
      throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "forumChannelIds 含非法 ID。");
    }
    if (seen.has(id)) continue;
    seen.add(id);
    forumChannelIds.push(id);
  }

  if (!Number.isFinite(config.silenceDays) || config.silenceDays <= 0) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "silenceDays 非法。");
  }

  const excludedTagIds = Array.isArray(config.excludedTagIds) ? config.excludedTagIds : [];
  if (!Array.isArray(config.excludedTagIds)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "excludedTagIds 必须为数组。");
  }
  for (const id of excludedTagIds) {
    if (!isDiscordSnowflake(String(id))) {
      throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "excludedTagIds 含非法 ID。");
    }
  }

  if (typeof config.skipPinned !== "boolean") {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "skipPinned 必须为 boolean。");
  }
  if (!isSafePositiveInt(config.dailyLimit)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "dailyLimit 非法。");
  }
  if (!isSafeNonNegInt(config.cooldownMs)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "cooldownMs 非法。");
  }
  if (!isSafeNonNegInt(config.cooldownJitterMs)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "cooldownJitterMs 非法。");
  }
  if (!isSafePositiveInt(config.idlePollMs)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "idlePollMs 非法。");
  }
  if (!isSafePositiveInt(config.failureBackoffMs)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "failureBackoffMs 非法。");
  }
  if (!isValidIanaTimezone(config.timezone)) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "timezone 非法。");
  }

  const start = parseHhMm(config.activeStart);
  const end = parseHhMm(config.activeEnd);
  if (!start || !end) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "activeStart/activeEnd 必须为 HH:mm。");
  }
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  if (startMin >= endMin) {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "activeStart 必须早于 activeEnd（不支持跨午夜）。");
  }

  return {
    enabled: config.enabled,
    guildId: config.guildId,
    forumChannelIds,
    silenceDays: config.silenceDays,
    excludedTagIds: excludedTagIds.map(String),
    skipPinned: config.skipPinned,
    dailyLimit: config.dailyLimit,
    cooldownMs: config.cooldownMs,
    cooldownJitterMs: config.cooldownJitterMs,
    idlePollMs: config.idlePollMs,
    failureBackoffMs: config.failureBackoffMs,
    timezone: config.timezone,
    activeStart: config.activeStart,
    activeEnd: config.activeEnd,
  };
}

/** 测试用推荐默认配置骨架（不含 guild/forum）。 */
export const SCHEDULER_REFERENCE_DEFAULTS = Object.freeze({
  silenceDays: 30,
  excludedTagIds: [],
  skipPinned: true,
  dailyLimit: 10,
  cooldownMs: 30 * 60 * 1000,
  cooldownJitterMs: 10 * 60 * 1000,
  idlePollMs: 30 * 60 * 1000,
  failureBackoffMs: 5 * 60 * 1000,
  timezone: "Asia/Shanghai",
  activeStart: "10:00",
  activeEnd: "22:00",
});
