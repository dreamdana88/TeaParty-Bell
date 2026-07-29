/**
 * Forum Bump 正式配置解析（环境变量 → 纯对象）。
 *
 * 不读取 Discord Token；不连接 Discord。
 * 非法值必须抛错，禁止静默回退。
 */

import { resolve } from "path";
import { isDiscordSnowflake } from "../features/forumBump/activityTime.js";
import {
  isValidIanaTimezone,
  parseHhMm,
  SchedulerConfigError,
} from "../features/forumBump/schedulerConfig.js";
import { FORUM_BUMP_STATE_PATH } from "../features/forumBump/stateSchema.js";
import { FORUM_BUMP_DYNAMIC_CONFIG_PATH } from "../features/forumBump/dynamicConfigSchema.js";
import { computeAutoInterval } from "../features/forumBump/autoInterval.js";
import { ConfigError } from "./configError.js";

export const FORUM_BUMP_MODES = Object.freeze(["disabled", "dry_run", "execute"]);

export const FORUM_BUMP_DEFAULTS = Object.freeze({
  mode: "disabled",
  silenceDays: 30,
  skipPinned: true,
  dailyLimit: 3,
  cooldownMinutes: 40,
  cooldownJitterMinutes: 10,
  idlePollMinutes: 30,
  failureBackoffMinutes: 5,
  timezone: "Asia/Shanghai",
  activeStart: "10:00",
  activeEnd: "22:00",
  statePath: FORUM_BUMP_STATE_PATH,
  dynamicConfigPath: FORUM_BUMP_DYNAMIC_CONFIG_PATH,
  dailyLimitMin: 1,
  dailyLimitMax: 10,
});

/**
 * 按逗号解析 Snowflake 列表：trim、过滤空项、去重、保序。
 * @param {string|undefined|null} raw
 * @param {string} fieldName
 * @returns {string[]}
 */
export function parseSnowflakeList(raw, fieldName) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return [];
  }
  if (typeof raw !== "string") {
    throw new ConfigError(
      `${fieldName} 必须为逗号分隔的 Snowflake 字符串`,
      "forum_bump_config_invalid",
      78,
    );
  }
  const parts = raw.split(",");
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const id = part.trim();
    if (!id) continue;
    if (!isDiscordSnowflake(id)) {
      throw new ConfigError(
        `${fieldName} 含非法 Snowflake：${id}`,
        "forum_bump_config_invalid",
        78,
      );
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 严格布尔：未设置 → default；显式非法 → throw。
 * @param {string|undefined|null} raw
 * @param {boolean} defaultValue
 * @param {string} fieldName
 */
export function parseStrictBool(raw, defaultValue, fieldName) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new ConfigError(
    `${fieldName} 非法布尔值：${raw}`,
    "forum_bump_config_invalid",
    78,
  );
}

/**
 * 严格正整数：未设置 → default；显式非法 → throw（禁止 NaN 回退）。
 * @param {string|undefined|null} raw
 * @param {number} defaultValue
 * @param {string} fieldName
 * @param {{ min?: number, max?: number }} [bounds]
 */
export function parseStrictInt(raw, defaultValue, fieldName, bounds = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return defaultValue;
  }
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) {
    throw new ConfigError(
      `${fieldName} 必须为整数，收到：${raw}`,
      "forum_bump_config_invalid",
      78,
    );
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n)) {
    throw new ConfigError(
      `${fieldName} 超出安全整数范围`,
      "forum_bump_config_invalid",
      78,
    );
  }
  if (bounds.min != null && n < bounds.min) {
    throw new ConfigError(
      `${fieldName} 不得小于 ${bounds.min}，收到：${n}`,
      "forum_bump_config_invalid",
      78,
    );
  }
  if (bounds.max != null && n > bounds.max) {
    throw new ConfigError(
      `${fieldName} 不得大于 ${bounds.max}，收到：${n}`,
      "forum_bump_config_invalid",
      78,
    );
  }
  return n;
}

/**
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [env]
 * @param {{ projectRoot?: string }} [options]
 */
export function loadForumBumpConfig(env = process.env, options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();

  const rawMode = (env.FORUM_BUMP_MODE ?? "").trim().toLowerCase();
  let mode;
  if (!rawMode) {
    mode = FORUM_BUMP_DEFAULTS.mode;
  } else if (FORUM_BUMP_MODES.includes(rawMode)) {
    mode = rawMode;
  } else {
    throw new ConfigError(
      `FORUM_BUMP_MODE 非法："${env.FORUM_BUMP_MODE}"。合法值：disabled | dry_run | execute`,
      "forum_bump_mode_invalid",
      78,
    );
  }

  const forumChannelIds = parseSnowflakeList(
    env.FORUM_BUMP_FORUM_CHANNEL_IDS,
    "FORUM_BUMP_FORUM_CHANNEL_IDS",
  );
  const excludedTagIds = parseSnowflakeList(
    env.FORUM_BUMP_EXCLUDED_TAG_IDS,
    "FORUM_BUMP_EXCLUDED_TAG_IDS",
  );

  const silenceDays = parseStrictInt(
    env.FORUM_BUMP_SILENCE_DAYS,
    FORUM_BUMP_DEFAULTS.silenceDays,
    "FORUM_BUMP_SILENCE_DAYS",
    { min: 1 },
  );
  const skipPinned = parseStrictBool(
    env.FORUM_BUMP_SKIP_PINNED,
    FORUM_BUMP_DEFAULTS.skipPinned,
    "FORUM_BUMP_SKIP_PINNED",
  );
  const dailyLimit = parseStrictInt(
    env.FORUM_BUMP_DAILY_LIMIT,
    FORUM_BUMP_DEFAULTS.dailyLimit,
    "FORUM_BUMP_DAILY_LIMIT",
    { min: FORUM_BUMP_DEFAULTS.dailyLimitMin, max: FORUM_BUMP_DEFAULTS.dailyLimitMax },
  );
  const cooldownMinutes = parseStrictInt(
    env.FORUM_BUMP_COOLDOWN_MINUTES,
    FORUM_BUMP_DEFAULTS.cooldownMinutes,
    "FORUM_BUMP_COOLDOWN_MINUTES",
    { min: 0 },
  );
  const cooldownJitterMinutes = parseStrictInt(
    env.FORUM_BUMP_COOLDOWN_JITTER_MINUTES,
    FORUM_BUMP_DEFAULTS.cooldownJitterMinutes,
    "FORUM_BUMP_COOLDOWN_JITTER_MINUTES",
    { min: 0 },
  );
  const idlePollMinutes = parseStrictInt(
    env.FORUM_BUMP_IDLE_POLL_MINUTES,
    FORUM_BUMP_DEFAULTS.idlePollMinutes,
    "FORUM_BUMP_IDLE_POLL_MINUTES",
    { min: 1 },
  );
  const failureBackoffMinutes = parseStrictInt(
    env.FORUM_BUMP_FAILURE_BACKOFF_MINUTES,
    FORUM_BUMP_DEFAULTS.failureBackoffMinutes,
    "FORUM_BUMP_FAILURE_BACKOFF_MINUTES",
    { min: 1 },
  );

  const timezone = (env.FORUM_BUMP_TIMEZONE ?? "").trim() || FORUM_BUMP_DEFAULTS.timezone;
  if (!isValidIanaTimezone(timezone)) {
    throw new ConfigError(
      `FORUM_BUMP_TIMEZONE 非法：${timezone}`,
      "forum_bump_config_invalid",
      78,
    );
  }

  const activeStart = (env.FORUM_BUMP_ACTIVE_START ?? "").trim() || FORUM_BUMP_DEFAULTS.activeStart;
  const activeEnd = (env.FORUM_BUMP_ACTIVE_END ?? "").trim() || FORUM_BUMP_DEFAULTS.activeEnd;
  const start = parseHhMm(activeStart);
  const end = parseHhMm(activeEnd);
  if (!start || !end) {
    throw new ConfigError(
      "FORUM_BUMP_ACTIVE_START/END 必须为 HH:mm",
      "forum_bump_config_invalid",
      78,
    );
  }
  if (start.hour * 60 + start.minute >= end.hour * 60 + end.minute) {
    throw new ConfigError(
      "FORUM_BUMP_ACTIVE_START 必须早于 FORUM_BUMP_ACTIVE_END（不支持跨午夜）",
      "forum_bump_config_invalid",
      78,
    );
  }

  const rawStatePath = (env.FORUM_BUMP_STATE_PATH ?? "").trim() || FORUM_BUMP_DEFAULTS.statePath;
  const statePath = resolve(projectRoot, rawStatePath);

  const rawDynamicConfigPath = (env.FORUM_BUMP_DYNAMIC_CONFIG_PATH ?? "").trim()
    || FORUM_BUMP_DEFAULTS.dynamicConfigPath;
  const dynamicConfigPath = resolve(projectRoot, rawDynamicConfigPath);

  // 部署层校验自动间隔（动态配置也会再次校验）
  if (mode === "dry_run" || mode === "execute") {
    const interval = computeAutoInterval(activeStart, activeEnd, dailyLimit);
    if (!interval.ok) {
      throw new ConfigError(
        interval.safeMessage || "Forum Bump 自动间隔配置非法",
        interval.errorCode || "forum_bump_interval_invalid",
        78,
      );
    }
  }

  if (mode === "dry_run" || mode === "execute") {
    if (forumChannelIds.length === 0) {
      throw new ConfigError(
        `FORUM_BUMP_MODE=${mode} 时必须配置至少一个 FORUM_BUMP_FORUM_CHANNEL_IDS`,
        "forum_bump_forum_required",
        78,
      );
    }
    const guildId = (env.DISCORD_GUILD_ID ?? "").trim();
    if (!guildId || !isDiscordSnowflake(guildId)) {
      throw new ConfigError(
        `FORUM_BUMP_MODE=${mode} 时 DISCORD_GUILD_ID 必须为合法 Snowflake`,
        "forum_bump_guild_required",
        78,
      );
    }
  }

  // 成功顶帖间隔由自动算法决定；env 冷却仅兼容保留（deprecated）
  const auto = (mode === "dry_run" || mode === "execute")
    ? computeAutoInterval(activeStart, activeEnd, dailyLimit)
    : null;
  const autoIntervalMs = auto?.ok
    ? auto.intervalMs
    : cooldownMinutes * 60 * 1000;

  return {
    mode,
    guildId: (env.DISCORD_GUILD_ID ?? "").trim() || null,
    forumChannelIds,
    excludedTagIds,
    silenceDays,
    skipPinned,
    dailyLimit,
    /** @deprecated 成功间隔改用 autoIntervalMs；保留供兼容读取 */
    cooldownMs: cooldownMinutes * 60 * 1000,
    /** @deprecated 成功路径不再使用抖动 */
    cooldownJitterMs: cooldownJitterMinutes * 60 * 1000,
    autoIntervalMs,
    autoIntervalMinutes: auto?.ok ? auto.intervalMinutes : null,
    idlePollMs: idlePollMinutes * 60 * 1000,
    failureBackoffMs: failureBackoffMinutes * 60 * 1000,
    timezone,
    activeStart,
    activeEnd,
    statePath,
    statePathRelative: rawStatePath.replace(/\\/g, "/"),
    dynamicConfigPath,
    dynamicConfigPathRelative: rawDynamicConfigPath.replace(/\\/g, "/"),
  };
}

/**
 * 转为 Scheduler 可校验配置。
 * @param {ReturnType<typeof loadForumBumpConfig>} fb
 * @param {{ modeOverride?: string }} [opts]
 */
export function toSchedulerConfig(fb, opts = {}) {
  const mode = opts.modeOverride ?? fb.mode;
  if (mode === "disabled") {
    throw new SchedulerConfigError("SCHEDULER_CONFIG_INVALID", "disabled 模式不创建 Scheduler 配置");
  }
  // 成功顶帖间隔 = 自动间隔；抖动强制 0（禁止挤出时间窗的随机）
  let autoIntervalMs = fb.autoIntervalMs;
  if (!Number.isInteger(autoIntervalMs) || autoIntervalMs <= 0) {
    const auto = computeAutoInterval(fb.activeStart, fb.activeEnd, fb.dailyLimit);
    if (!auto.ok) {
      throw new SchedulerConfigError(
        auto.errorCode || "SCHEDULER_CONFIG_INVALID",
        auto.safeMessage || "自动间隔非法",
      );
    }
    autoIntervalMs = auto.intervalMs;
  }
  return {
    enabled: true,
    mode: mode === "dry_run" ? "dry_run" : "execute",
    guildId: fb.guildId,
    forumChannelIds: fb.forumChannelIds,
    silenceDays: fb.silenceDays,
    excludedTagIds: fb.excludedTagIds,
    skipPinned: fb.skipPinned,
    dailyLimit: fb.dailyLimit,
    // Scheduler 内部 cooldownMs 承载自动间隔（语义：成功后最短间隔）
    cooldownMs: autoIntervalMs,
    cooldownJitterMs: 0,
    idlePollMs: fb.idlePollMs,
    failureBackoffMs: fb.failureBackoffMs,
    timezone: fb.timezone,
    activeStart: fb.activeStart,
    activeEnd: fb.activeEnd,
  };
}

/**
 * 将动态配置四项叠加到部署基线（mode/timezone/statePath 等不可覆盖）。
 * @param {object} baseForumBump loadForumBumpConfig 结果
 * @param {object} dynamicDoc 已校验动态配置
 */
export function applyDynamicConfigOverlay(baseForumBump, dynamicDoc) {
  const next = {
    ...baseForumBump,
    dailyLimit: dynamicDoc.dailyLimit,
    activeStart: dynamicDoc.activeStart,
    activeEnd: dynamicDoc.activeEnd,
    forumChannelIds: [...dynamicDoc.forumChannelIds],
    silenceDays: dynamicDoc.silenceDays,
  };
  const auto = computeAutoInterval(next.activeStart, next.activeEnd, next.dailyLimit);
  if (!auto.ok) {
    throw new SchedulerConfigError(
      auto.errorCode || "SCHEDULER_CONFIG_INVALID",
      auto.safeMessage || "自动间隔非法",
    );
  }
  next.autoIntervalMs = auto.intervalMs;
  next.autoIntervalMinutes = auto.intervalMinutes;
  return next;
}
