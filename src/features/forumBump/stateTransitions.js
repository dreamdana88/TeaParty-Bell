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

// 各转换先经 validateState 得到新副本 current，可直接在其上修改；ok() 输出时再拷贝一次。
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

  if (typeof operationId !== "string"
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

  current.inFlight = {
    operationId,
    guildId,
    forumChannelId,
    threadId,
    phase: "before_send",
    sentMessageId: null,
    startedAt,
    updatedAt: startedAt,
  };
  validateInFlight(current.inFlight);
  return ok(current);
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

  current.inFlight.phase = "after_send";
  current.inFlight.sentMessageId = sentMessageId;
  current.inFlight.updatedAt = sentAt;
  validateInFlight(current.inFlight);
  return ok(current);
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

  current.inFlight.phase = "after_delete";
  current.inFlight.updatedAt = deletedAt;
  validateInFlight(current.inFlight);
  return ok(current);
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

  if (localDate > current.localDate) {
    // 跨日：先归零再 +1
    current.localDate = localDate;
    current.successCount = 0;
  }
  current.successCount += 1;
  current.lastSuccessAt = successAt;
  current.nextEligibleAt = nextEligibleAt;
  current.inFlight = null;
  return ok(current);
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
  current.paused = true;
  current.pauseReason = reason;
  return ok(current);
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
  current.paused = false;
  current.pauseReason = null;
  return ok(current);
}

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
  current.inFlight = null;
  return ok(current);
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
  if (current.nextEligibleAt !== null
    && Date.parse(current.nextEligibleAt) >= Date.parse(nextEligibleAt)) {
    return ok(current, false);
  }
  current.nextEligibleAt = nextEligibleAt;
  return ok(current);
}

/**
 * 配置热更新补偿：允许将 nextEligibleAt 恢复为任意合法值（含 null / 回拨）。
 * 不用于普通 defer 路径。
 * @param {object} state
 * @param {object} input
 */
export function restoreNextEligibleAtTransition(state, input) {
  const current = validateState(state);
  if (current.inFlight) {
    return fail("STATE_INFLIGHT_EXISTS");
  }
  const raw = input?.nextEligibleAt;
  let target = null;
  if (raw !== null && raw !== undefined) {
    if (!isValidIsoTimestamp(raw)) {
      return fail("STATE_ARGUMENT_INVALID");
    }
    target = raw;
  }
  if (current.nextEligibleAt === target) {
    return ok(current, false);
  }
  current.nextEligibleAt = target;
  return ok(current);
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
  current.localDate = localDate;
  current.successCount = 0;
  // 保留 lastSuccessAt / nextEligibleAt / paused / pauseReason / inFlight
  return ok(current);
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
  current.paused = true;
  current.pauseReason = classification.suggestedPauseReason;
  return { ...ok(current, true), classification };
}

/**
 * recoverOnStartup 用：计算应写入的下一状态与恢复元数据。
 * @param {object} state
 */
export function planStartupRecovery(state) {
  const result = applyStartupRecoveryPause(state);
  return {
    nextState: result.state,
    changed: result.changed,
    recoveryStatus: result.classification.recoveryStatus,
    cleanupRequired: result.classification.cleanupRequired,
  };
}
