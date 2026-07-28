/**
 * 调度决策纯函数：下一次唤醒、抖动、冷却。
 */

import {
  clampToActiveWindow,
  getLocalDate,
  getNextBusinessDayWindowStart,
  getNextWindowStart,
  isInsideActiveWindow,
  toUtcIso,
} from "./businessTime.js";
import { isValidIsoTimestamp } from "./stateSchema.js";

export const MAX_TIMER_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {number} r random in [0,1)
 * @param {number} cooldownJitterMs
 */
export function computeJitterMs(r, cooldownJitterMs) {
  if (!Number.isFinite(r) || r < 0 || r >= 1) {
    return { ok: false, errorCode: "SCHEDULER_RANDOM_INVALID" };
  }
  if (!Number.isInteger(cooldownJitterMs) || cooldownJitterMs < 0) {
    return { ok: false, errorCode: "SCHEDULER_CONFIG_INVALID" };
  }
  const jitterMs = Math.floor(r * (cooldownJitterMs + 1));
  if (jitterMs < 0 || jitterMs > cooldownJitterMs) {
    return { ok: false, errorCode: "SCHEDULER_RANDOM_INVALID" };
  }
  return { ok: true, jitterMs };
}

/**
 * @param {number} successAtMs
 * @param {number} cooldownMs
 * @param {number} jitterMs
 */
export function computeNextEligibleAtMs(successAtMs, cooldownMs, jitterMs) {
  return successAtMs + cooldownMs + jitterMs;
}

/**
 * 根据当前状态与配置决定下一次唤醒时间（UTC ms）。
 * @param {object} input
 */
export function decideNextWakeAt({
  nowMs,
  config,
  state,
  reason,
}) {
  const {
    timezone,
    activeStart,
    activeEnd,
    dailyLimit,
    idlePollMs,
    failureBackoffMs,
  } = config;

  // paused / recovery：不自动唤醒
  if (state?.paused || reason === "paused" || reason === "recovery_required" || reason === "halt") {
    return { nextWakeAt: null, delayMs: null, reason: reason || "paused" };
  }

  if (!config.enabled || reason === "disabled") {
    return { nextWakeAt: null, delayMs: null, reason: "disabled" };
  }

  // 窗口外
  if (!isInsideActiveWindow(nowMs, timezone, activeStart, activeEnd)) {
    const wake = getNextWindowStart(nowMs, timezone, activeStart, activeEnd);
    return { nextWakeAt: wake, delayMs: Math.max(0, wake - nowMs), reason: "outside_window" };
  }

  // 每日上限
  if ((state?.successCount ?? 0) >= dailyLimit || reason === "daily_limit") {
    const wake = getNextBusinessDayWindowStart(nowMs, timezone, activeStart);
    return { nextWakeAt: wake, delayMs: Math.max(0, wake - nowMs), reason: "daily_limit" };
  }

  // 冷却
  if (state?.nextEligibleAt && isValidIsoTimestamp(state.nextEligibleAt)) {
    const eligibleMs = Date.parse(state.nextEligibleAt);
    if (eligibleMs > nowMs) {
      const clamped = clampToActiveWindow(eligibleMs, timezone, activeStart, activeEnd);
      return {
        nextWakeAt: clamped,
        delayMs: Math.max(0, clamped - nowMs),
        reason: "cooldown",
      };
    }
  }

  if (reason === "no_candidate" || reason === "skipped") {
    const raw = nowMs + idlePollMs;
    const wake = clampToActiveWindow(raw, timezone, activeStart, activeEnd);
    return { nextWakeAt: wake, delayMs: Math.max(0, wake - nowMs), reason: reason || "idle" };
  }

  if (reason === "failure_backoff") {
    const raw = nowMs + failureBackoffMs;
    const wake = clampToActiveWindow(raw, timezone, activeStart, activeEnd);
    return { nextWakeAt: wake, delayMs: Math.max(0, wake - nowMs), reason: "failure_backoff" };
  }

  // 默认可立即尝试（本轮后）
  return { nextWakeAt: nowMs, delayMs: 0, reason: reason || "ready" };
}

/**
 * 将目标唤醒时间转为单次 timer delay（分段）。
 */
export function computeTimerDelayMs(nowMs, nextWakeAt) {
  if (nextWakeAt == null) return null;
  const raw = Math.max(0, nextWakeAt - nowMs);
  return Math.min(raw, MAX_TIMER_DELAY_MS);
}

export function formatSuccessAtIso(nowMs) {
  return toUtcIso(nowMs);
}

export function successLocalDate(nowMs, timezone) {
  return getLocalDate(nowMs, timezone);
}
