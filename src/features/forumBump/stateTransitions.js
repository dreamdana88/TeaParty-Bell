/**
 * Forum Bump 纯状态转换（无 IO / 无时钟 / 无日志）。
 */

import { isDiscordSnowflake } from "./activityTime.js";
import {
  cloneState,
  createStateError,
  isValidIsoTimestamp,
  isValidLocalDate,
  validateInFlight,
  validateState,
} from "./stateSchema.js";

function ok(state, changed = true) {
  return { ok: true, changed, state: cloneState(state), errorCode: null };
}

function fail(code, context = null) {
  return { ok: false, changed: false, state: null, errorCode: code, context };
}

function requireInFlight(state, operationId) {
  if (!state.inFlight) {
    return fail("STATE_INFLIGHT_NOT_FOUND");
  }
  if (state.inFlight.operationId !== operationId) {
    return fail("STATE_INFLIGHT_MISMATCH", { operationId });
  }
  return null;
}

/**
 * @param {object} state
 * @param {object} input
 */
export function beginInFlightTransition(state, input) {
  const current = validateState(state);
  const {
    operationId,
    guildId,
    forumChannelId,
    threadId,
    startedAt,
  } = input ?? {};

  if (typeof operationId !== "string" || operationId.trim().length === 0
    || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(operationId)
    || !isDiscordSnowflake(guildId)
    || !isDiscordSnowflake(forumChannelId)
    || !isDiscordSnowflake(threadId)
    || !isValidIsoTimestamp(startedAt)) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  if (current.paused) {
    return fail("STATE_PAUSED");
  }
  if (current.inFlight) {
    return fail("STATE_INFLIGHT_EXISTS");
  }

  const next = cloneState(current);
  next.inFlight = {
    operationId,
    guildId,
    forumChannelId,
    threadId,
    phase: "before_send",
    sentMessageId: null,
    startedAt,
    updatedAt: startedAt,
  };
  validateInFlight(next.inFlight);
  return ok(next);
}

/**
 * @param {object} state
 * @param {object} input
 */
export function markMessageSentTransition(state, input) {
  const current = validateState(state);
  const { operationId, sentMessageId, sentAt } = input ?? {};
  if (!isDiscordSnowflake(sentMessageId) || !isValidIsoTimestamp(sentAt)
    || typeof operationId !== "string") {
    return fail("STATE_ARGUMENT_INVALID");
  }
  const miss = requireInFlight(current, operationId);
  if (miss) return miss;
  if (current.inFlight.phase !== "before_send") {
    return fail("STATE_TRANSITION_INVALID", { phase: current.inFlight.phase });
  }

  const next = cloneState(current);
  next.inFlight.phase = "after_send";
  next.inFlight.sentMessageId = sentMessageId;
  next.inFlight.updatedAt = sentAt;
  validateInFlight(next.inFlight);
  return ok(next);
}

/**
 * @param {object} state
 * @param {object} input
 */
export function markMessageDeletedTransition(state, input) {
  const current = validateState(state);
  const { operationId, deletedAt } = input ?? {};
  if (typeof operationId !== "string" || !isValidIsoTimestamp(deletedAt)) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  const miss = requireInFlight(current, operationId);
  if (miss) return miss;
  if (current.inFlight.phase !== "after_send") {
    return fail("STATE_TRANSITION_INVALID", { phase: current.inFlight.phase });
  }
  if (!isDiscordSnowflake(current.inFlight.sentMessageId)) {
    return fail("STATE_TRANSITION_INVALID");
  }

  const next = cloneState(current);
  next.inFlight.phase = "after_delete";
  next.inFlight.updatedAt = deletedAt;
  validateInFlight(next.inFlight);
  return ok(next);
}

/**
 * @param {object} state
 * @param {object} input
 */
export function completeSuccessTransition(state, input) {
  const current = validateState(state);
  const {
    operationId,
    localDate,
    successAt,
    nextEligibleAt,
  } = input ?? {};

  if (typeof operationId !== "string"
    || !isValidLocalDate(localDate)
    || !isValidIsoTimestamp(successAt)
    || !isValidIsoTimestamp(nextEligibleAt)) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  if (Date.parse(nextEligibleAt) < Date.parse(successAt)) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  if (current.paused) {
    return fail("STATE_PAUSED");
  }
  const miss = requireInFlight(current, operationId);
  if (miss) return miss;
  if (current.inFlight.phase !== "after_delete") {
    return fail("STATE_TRANSITION_INVALID", { phase: current.inFlight.phase });
  }

  // 业务日期回退：拒绝，防止额度被重置
  if (localDate < current.localDate) {
    return fail("STATE_DATE_ROLLBACK");
  }

  const next = cloneState(current);
  if (localDate > next.localDate) {
    // 跨日：先归零再 +1
    next.localDate = localDate;
    next.successCount = 0;
  }
  next.successCount += 1;
  next.lastSuccessAt = successAt;
  next.nextEligibleAt = nextEligibleAt;
  next.inFlight = null;
  return ok(next);
}

/**
 * @param {object} state
 * @param {object} input
 */
export function pauseTransition(state, input) {
  const current = validateState(state);
  const reason = input?.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  if (current.paused === true && current.pauseReason === reason) {
    return ok(current, false);
  }
  const next = cloneState(current);
  next.paused = true;
  next.pauseReason = reason;
  return ok(next);
}

/**
 * @param {object} state
 */
export function resumeTransition(state) {
  const current = validateState(state);
  if (!current.paused) {
    return fail("STATE_TRANSITION_INVALID");
  }
  if (current.inFlight) {
    return fail("STATE_RECOVERY_REQUIRED");
  }
  const next = cloneState(current);
  next.paused = false;
  next.pauseReason = null;
  return ok(next);
}

/**
 * @param {object} state
 * @param {object} input
 */
/**
 * 放弃 before_send 阶段的 inFlight（确认未发出合法消息）。
 * @param {object} state
 * @param {object} input
 */
export function abandonBeforeSendTransition(state, input) {
  const current = validateState(state);
  const { operationId } = input ?? {};
  if (typeof operationId !== "string") {
    return fail("STATE_ARGUMENT_INVALID");
  }
  const miss = requireInFlight(current, operationId);
  if (miss) return miss;
  if (current.inFlight.phase !== "before_send") {
    return fail("STATE_TRANSITION_INVALID", { phase: current.inFlight.phase });
  }
  const next = cloneState(current);
  next.inFlight = null;
  return ok(next);
}

/**
 * 仅允许将 nextEligibleAt 向后推迟。
 * @param {object} state
 * @param {object} input
 */
export function deferUntilTransition(state, input) {
  const current = validateState(state);
  const { nextEligibleAt } = input ?? {};
  if (!isValidIsoTimestamp(nextEligibleAt)) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  if (current.paused) {
    return fail("STATE_PAUSED");
  }
  if (current.inFlight) {
    return fail("STATE_INFLIGHT_EXISTS");
  }
  if (current.nextEligibleAt != null) {
    if (!isValidIsoTimestamp(current.nextEligibleAt)) {
      return fail("STATE_INVALID");
    }
    if (Date.parse(current.nextEligibleAt) >= Date.parse(nextEligibleAt)) {
      return ok(current, false);
    }
  }
  const next = cloneState(current);
  next.nextEligibleAt = nextEligibleAt;
  return ok(next);
}

export function rolloverLocalDateTransition(state, input) {
  const current = validateState(state);
  const localDate = input?.localDate;
  if (!isValidLocalDate(localDate)) {
    return fail("STATE_ARGUMENT_INVALID");
  }
  if (localDate === current.localDate) {
    return ok(current, false);
  }
  if (localDate < current.localDate) {
    return fail("STATE_DATE_ROLLBACK");
  }
  const next = cloneState(current);
  next.localDate = localDate;
  next.successCount = 0;
  // 保留 lastSuccessAt / nextEligibleAt / paused / pauseReason / inFlight
  return ok(next);
}

/**
 * 启动恢复分类（纯函数，不修改状态）。
 * @param {object} state
 */
export function classifyRecovery(state) {
  const current = validateState(state);
  if (!current.inFlight) {
    return {
      recoveryStatus: "clean",
      cleanupRequired: false,
      suggestedPauseReason: null,
    };
  }
  if (current.inFlight.phase === "before_send") {
    return {
      recoveryStatus: "manual_review_required",
      cleanupRequired: false,
      suggestedPauseReason: "INFLIGHT_BEFORE_SEND",
    };
  }
  if (current.inFlight.phase === "after_send") {
    return {
      recoveryStatus: "cleanup_required",
      cleanupRequired: true,
      suggestedPauseReason: "INFLIGHT_MESSAGE_MAY_EXIST",
    };
  }
  // after_delete
  return {
    recoveryStatus: "reconciliation_required",
    cleanupRequired: false,
    suggestedPauseReason: "INFLIGHT_SUCCESS_RECONCILIATION_REQUIRED",
  };
}

/**
 * 应用启动恢复暂停（不覆盖已有 pauseReason）。
 * @param {object} state
 */
export function applyStartupRecoveryPause(state) {
  const current = validateState(state);
  const classification = classifyRecovery(current);
  if (classification.recoveryStatus === "clean") {
    return { ...ok(current, false), classification };
  }
  if (current.paused) {
    return { ...ok(current, false), classification };
  }
  const next = cloneState(current);
  next.paused = true;
  next.pauseReason = classification.suggestedPauseReason;
  return { ...ok(next, true), classification };
}

export { createStateError };
