/**
 * 自动顶帖间隔：活跃时段总时长 ÷ 每日额度。
 * 最短 30 分钟；无随机抖动；不追赶补齐。
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
 * 自动间隔（分钟）。不足 30 分钟返回 ok=false。
 * @param {string} activeStart
 * @param {string} activeEnd
 * @param {number} dailyLimit
 * @returns {{ ok: true, intervalMinutes: number, intervalMs: number, windowMinutes: number }
 *   | { ok: false, errorCode: string, safeMessage: string }}
 */
export function computeAutoInterval(activeStart, activeEnd, dailyLimit) {
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_INVALID",
      safeMessage: "dailyLimit 必须为 1–10 的整数。",
    };
  }
  const windowMinutes = computeActiveWindowMinutes(activeStart, activeEnd);
  if (windowMinutes == null) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_INVALID",
      safeMessage: "活跃时间窗非法。",
    };
  }
  const exactMinutes = windowMinutes / dailyLimit;
  if (exactMinutes < MIN_AUTO_INTERVAL_MINUTES) {
    return {
      ok: false,
      errorCode: "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT",
      safeMessage: `自动间隔 ${exactMinutes.toFixed(2)} 分钟低于最短 ${MIN_AUTO_INTERVAL_MINUTES} 分钟。`,
      windowMinutes,
      exactMinutes,
    };
  }
  // 使用精确毫秒（总毫秒 / limit），避免浮点误差；展示用 floor 分钟
  const intervalMs = Math.floor((windowMinutes * 60 * 1000) / dailyLimit);
  const intervalMinutes = Math.floor(intervalMs / 60_000);
  return {
    ok: true,
    intervalMinutes,
    intervalMs,
    windowMinutes,
    exactMinutes,
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
