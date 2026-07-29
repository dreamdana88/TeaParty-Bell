/**
 * 自动顶帖间隔：活跃时段总时长 ÷ 每日额度。
 * 最短间隔 30 分钟；绝对每日上限 30；无随机抖动；不追赶补齐。
 */

import { parseHhMm } from "./schedulerConfig.js";
import {
  getLocalDate,
  getNextBusinessDayWindowStart,
  getNextWindowStart,
  isInsideActiveWindow,
  toUtcIso,
} from "./businessTime.js";
import { isValidIsoTimestamp } from "./stateSchema.js";

export const MIN_AUTO_INTERVAL_MINUTES = 30;
/** 绝对每日顶帖上限 */
export const ABSOLUTE_DAILY_LIMIT_MAX = 30;
export const DAILY_LIMIT_MIN = 1;

/**
 * 活跃窗口总分钟数（同日 start < end）。
 * @param {string} activeStart
 * @param {string} activeEnd
 * @returns {number|null}
 */
export function computeActiveWindowMinutes(activeStart, activeEnd) {
  const start = parseHhMm(activeStart);
  const end = parseHhMm(activeEnd);
  if (!start || !end) return null;
  const startMin = start.hour * 60 + start.minute;
  const endMin = end.hour * 60 + end.minute;
  if (startMin >= endMin) return null;
  return endMin - startMin;
}

/**
 * 当前活跃窗可用的最大 dailyLimit。
 * max = min(30, floor(窗口分钟 / 30))
 * @param {string} activeStart
 * @param {string} activeEnd
 * @returns {{ ok: true, maxDailyLimit: number, windowMinutes: number }
 *   | { ok: false, errorCode: string, safeMessage: string }}
 */
export function computeMaxDailyLimit(activeStart, activeEnd) {
  const windowMinutes = computeActiveWindowMinutes(activeStart, activeEnd);
  if (windowMinutes == null) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_INVALID",
      safeMessage: "活跃时间窗非法。",
    };
  }
  if (windowMinutes < MIN_AUTO_INTERVAL_MINUTES) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT",
      safeMessage: "活跃时段过短，至少需要 30 分钟。",
      windowMinutes,
      maxDailyLimit: 0,
    };
  }
  const byInterval = Math.floor(windowMinutes / MIN_AUTO_INTERVAL_MINUTES);
  const maxDailyLimit = Math.min(ABSOLUTE_DAILY_LIMIT_MAX, byInterval);
  if (maxDailyLimit < DAILY_LIMIT_MIN) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT",
      safeMessage: "活跃时段过短，无法安排顶帖。",
      windowMinutes,
      maxDailyLimit: 0,
    };
  }
  return {
    ok: true,
    maxDailyLimit,
    windowMinutes,
  };
}

/**
 * 校验 dailyLimit 相对活跃窗与绝对上限。
 * @returns {{ ok: true, maxDailyLimit: number, windowMinutes: number }
 *   | { ok: false, errorCode: string, safeMessage: string, maxDailyLimit?: number }}
 */
export function validateDailyLimitForWindow(activeStart, activeEnd, dailyLimit) {
  if (!Number.isInteger(dailyLimit) || dailyLimit < DAILY_LIMIT_MIN) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_INVALID",
      safeMessage: "每日额度必须是至少为 1 的整数。",
    };
  }
  if (dailyLimit > ABSOLUTE_DAILY_LIMIT_MAX) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_INVALID",
      safeMessage: "每日额度最多为 30 次。",
      maxDailyLimit: ABSOLUTE_DAILY_LIMIT_MAX,
    };
  }
  const maxInfo = computeMaxDailyLimit(activeStart, activeEnd);
  if (!maxInfo.ok) {
    return maxInfo;
  }
  if (dailyLimit > maxInfo.maxDailyLimit) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT",
      safeMessage: `当前活跃时段最多支持 ${maxInfo.maxDailyLimit} 次，请降低每日额度或延长活跃时间。`,
      maxDailyLimit: maxInfo.maxDailyLimit,
      windowMinutes: maxInfo.windowMinutes,
    };
  }
  return {
    ok: true,
    maxDailyLimit: maxInfo.maxDailyLimit,
    windowMinutes: maxInfo.windowMinutes,
  };
}

/**
 * 自动间隔（分钟）。
 * @param {string} activeStart
 * @param {string} activeEnd
 * @param {number} dailyLimit
 * @returns {{ ok: true, intervalMinutes: number, intervalMs: number, windowMinutes: number, maxDailyLimit: number }
 *   | { ok: false, errorCode: string, safeMessage: string, maxDailyLimit?: number }}
 */
export function computeAutoInterval(activeStart, activeEnd, dailyLimit) {
  const validated = validateDailyLimitForWindow(activeStart, activeEnd, dailyLimit);
  if (!validated.ok) {
    return validated;
  }
  const { windowMinutes, maxDailyLimit } = validated;
  const exactMinutes = windowMinutes / dailyLimit;
  // 理论上 validate 已保证 >= 30；双保险
  if (exactMinutes < MIN_AUTO_INTERVAL_MINUTES) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT",
      safeMessage: `当前活跃时段最多支持 ${maxDailyLimit} 次，请降低每日额度或延长活跃时间。`,
      windowMinutes,
      exactMinutes,
      maxDailyLimit,
    };
  }
  const intervalMs = Math.floor((windowMinutes * 60 * 1000) / dailyLimit);
  const intervalMinutes = Math.floor(intervalMs / 60_000);
  return {
    ok: true,
    intervalMinutes,
    intervalMs,
    windowMinutes,
    exactMinutes,
    maxDailyLimit,
  };
}

/**
 * 配置热更新后重算 nextEligibleAt（不重置 successCount / lastSuccessAt / inFlight）。
 *
 * @param {object} input
 * @returns {{ nextEligibleAt: string|null, nextEligibleAtMs: number|null, reason: string }}
 */
export function recomputeNextEligibleAfterConfigChange({
  nowMs,
  config,
  state,
}) {
  const {
    timezone,
    activeStart,
    activeEnd,
    dailyLimit,
    cooldownMs,
  } = config;

  const autoMs = Number.isInteger(cooldownMs) && cooldownMs > 0
    ? cooldownMs
    : (() => {
      const a = computeAutoInterval(activeStart, activeEnd, dailyLimit);
      return a.ok ? a.intervalMs : MIN_AUTO_INTERVAL_MINUTES * 60_000;
    })();

  const successCount = state?.successCount ?? 0;

  // 今日已达新 dailyLimit
  if (successCount >= dailyLimit) {
    const wake = getNextBusinessDayWindowStart(nowMs, timezone, activeStart);
    return {
      nextEligibleAtMs: wake,
      nextEligibleAt: toUtcIso(wake),
      reason: "daily_limit",
    };
  }

  // 当前在活跃时间外
  if (!isInsideActiveWindow(nowMs, timezone, activeStart, activeEnd)) {
    const wake = getNextWindowStart(nowMs, timezone, activeStart, activeEnd);
    return {
      nextEligibleAtMs: wake,
      nextEligibleAt: toUtcIso(wake),
      reason: "outside_window",
    };
  }

  // 今日尚未成功顶帖且当前在窗口内：允许立即检查
  if (successCount === 0) {
    return {
      nextEligibleAtMs: nowMs,
      nextEligibleAt: toUtcIso(nowMs),
      reason: "ready",
    };
  }

  // 今日已有成功记录：max(now, lastSuccessAt + 新自动间隔)
  let lastMs = null;
  if (state?.lastSuccessAt && isValidIsoTimestamp(state.lastSuccessAt)) {
    lastMs = Date.parse(state.lastSuccessAt);
  }
  if (lastMs == null || !Number.isFinite(lastMs)) {
    return {
      nextEligibleAtMs: nowMs,
      nextEligibleAt: toUtcIso(nowMs),
      reason: "ready",
    };
  }

  const candidate = Math.max(nowMs, lastMs + autoMs);
  return {
    nextEligibleAtMs: candidate,
    nextEligibleAt: toUtcIso(candidate),
    reason: "cooldown",
  };
}

/**
 * 成功顶帖后的 nextEligibleAt：lastSuccess + autoInterval，无抖动。
 * @param {number} successAtMs
 * @param {number} autoIntervalMs
 */
export function computeSuccessNextEligibleAt(successAtMs, autoIntervalMs) {
  return successAtMs + autoIntervalMs;
}

export function localDateForNow(nowMs, timezone) {
  return getLocalDate(nowMs, timezone);
}
