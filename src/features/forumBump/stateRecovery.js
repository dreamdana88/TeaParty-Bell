/**
 * Forum Bump 崩溃恢复分类与启动恢复结果组装。
 */

import {
  applyStartupRecoveryPause,
  classifyRecovery,
} from "./stateTransitions.js";
import { cloneState, createStateError, validateState } from "./stateSchema.js";

/**
 * 纯分类：不改状态。
 * @param {object} state
 */
export function classifyInFlightRecovery(state) {
  return classifyRecovery(state);
}

/**
 * 根据当前状态计算 recoverOnStartup 应写入的下一状态与结果元数据。
 * @param {object} state
 */
export function planStartupRecovery(state) {
  const validated = validateState(state);
  const result = applyStartupRecoveryPause(validated);
  if (!result.ok) {
    throw createStateError(result.errorCode ?? "STATE_INVALID");
  }
  return {
    nextState: result.state,
    changed: result.changed,
    recoveryStatus: result.classification.recoveryStatus,
    cleanupRequired: result.classification.cleanupRequired,
    pauseReason: result.state.paused ? result.state.pauseReason : null,
    snapshot: cloneState(result.state),
  };
}

export { applyStartupRecoveryPause, classifyRecovery };
