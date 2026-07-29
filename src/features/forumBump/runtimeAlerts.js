/**
 * Forum Bump 周期结果 → Alert Outbox 映射。
 * 不创建第二套告警存储。
 */

/** Forum Bump 全部稳定 incident keys（通用 Ready 不得自动恢复） */
export const FORUM_BUMP_INCIDENT_KEYS = Object.freeze([
  "forum_bump_state_unavailable",
  "forum_bump_cleanup_required",
  "forum_bump_reconciliation_required",
  "forum_bump_scheduler_halted",
  "forum_bump_scheduler_unexpected_failed",
]);

/** 需要终止/人工关注的 status → incidentKey */
export const FORUM_BUMP_INCIDENT_BY_STATUS = Object.freeze({
  cleanup_required: "forum_bump_cleanup_required",
  reconciliation_required: "forum_bump_reconciliation_required",
  halted: "forum_bump_scheduler_halted",
  unexpected_failed: "forum_bump_scheduler_unexpected_failed",
  state_failed: "forum_bump_state_unavailable",
  recovery_required: "forum_bump_scheduler_halted",
  manual_review_required: "forum_bump_scheduler_halted",
});

/** 不创建终止告警的正常/空闲状态 */
export const FORUM_BUMP_NO_ALERT_STATUSES = new Set([
  "succeeded",
  "success",
  "no_candidate",
  "dry_run_candidate",
  "outside_window",
  "daily_limit",
  "cooldown",
  "disabled",
  "paused",
  "skipped",
  "cancelled",
  "stopped",
  "busy",
  "not_started",
  "stopping",
  "send_failed",
  "scan_failed",
  "failed",
]);

/**
 * 从周期结果构造脱敏 details。
 * @param {object|null|undefined} result
 * @param {object} [extra]
 */
/**
 * 从磁盘 inFlight 构造安全摘要（不得包含完整 state）。
 * @param {object|null|undefined} inFlight
 */
export function buildSafeInFlightSummary(inFlight) {
  if (!inFlight || typeof inFlight !== "object") return null;
  return {
    guildId: typeof inFlight.guildId === "string" ? inFlight.guildId : null,
    forumChannelId: typeof inFlight.forumChannelId === "string" ? inFlight.forumChannelId : null,
    threadId: typeof inFlight.threadId === "string" ? inFlight.threadId : null,
    sentMessageId: inFlight.sentMessageId == null ? null : String(inFlight.sentMessageId),
    inFlightPhase: typeof inFlight.phase === "string" ? inFlight.phase : null,
    operationId: typeof inFlight.operationId === "string" ? inFlight.operationId : null,
  };
}

export function buildSafeAlertDetails(result, extra = {}) {
  const summary = result?.inFlightSummary
    ?? (result?.inFlight ? buildSafeInFlightSummary(result.inFlight) : null)
    ?? null;
  const details = {
    status: result?.status ?? null,
    errorCode: result?.errorCode ?? null,
    primaryErrorCode: result?.primaryErrorCode ?? null,
    stateErrorCode: result?.stateErrorCode ?? null,
    cleanupRequired: result?.cleanupRequired === true,
    sentMessageId: result?.sentMessageId
      ?? summary?.sentMessageId
      ?? null,
    pauseReason: result?.pauseReason ?? null,
    operationId: result?.operationId
      ?? summary?.operationId
      ?? null,
    inFlightPhase: result?.inFlightPhase
      ?? summary?.inFlightPhase
      ?? null,
    guildId: extra.guildId
      ?? result?.candidate?.guildId
      ?? summary?.guildId
      ?? null,
    forumChannelId: extra.forumChannelId
      ?? result?.candidate?.forumChannelId
      ?? summary?.forumChannelId
      ?? null,
    threadId: extra.threadId
      ?? result?.candidate?.threadId
      ?? summary?.threadId
      ?? null,
  };
  return details;
}

/**
 * @param {object|null|undefined} result
 * @returns {string|null} incidentKey
 */
export function mapCycleResultToIncidentKey(result) {
  if (!result || typeof result !== "object") return null;
  const status = result.status;
  if (!status || FORUM_BUMP_NO_ALERT_STATUSES.has(status)) {
    // send_failed / scan_failed 用 failure backoff，不写终止 incident
    return null;
  }
  if (FORUM_BUMP_INCIDENT_BY_STATUS[status]) {
    return FORUM_BUMP_INCIDENT_BY_STATUS[status];
  }
  // 显式 error 路径
  if (result.errorCode === "DELETE_FAILED" || result.cleanupRequired) {
    return "forum_bump_cleanup_required";
  }
  if (result.success === false && result.errorCode) {
    return "forum_bump_scheduler_unexpected_failed";
  }
  return null;
}

/**
 * @param {object} options
 * @param {{ notifyFailure: Function, notifyRecovery?: Function }} options.alertNotifier
 * @param {object} [options.logger]
 * @param {string} [options.guildId]
 */
export function createForumBumpAlertHandler({ alertNotifier, logger, guildId = null } = {}) {
  if (!alertNotifier || typeof alertNotifier.notifyFailure !== "function") {
    throw new TypeError("createForumBumpAlertHandler 需要 alertNotifier.notifyFailure");
  }

  async function handleCycleResult(result) {
    const incidentKey = mapCycleResultToIncidentKey(result);
    if (!incidentKey) return { alerted: false, incidentKey: null };

    const details = buildSafeAlertDetails(result, { guildId });
    const message = `Forum Bump 需要关注：status=${details.status} errorCode=${details.errorCode ?? "none"}`;
    await alertNotifier.notifyFailure(incidentKey, message, {
      guildId,
      details,
    });
    return { alerted: true, incidentKey };
  }

  /**
   * 健康启动后尝试恢复相关 incidents。
   * 仅当状态干净（paused=false, inFlight=null）且 Runtime 成功启动后调用。
   */
  async function notifyHealthyRecoveries() {
    if (typeof alertNotifier.notifyRecovery !== "function") return;
    const keys = [
      "forum_bump_state_unavailable",
      "forum_bump_cleanup_required",
      "forum_bump_reconciliation_required",
      "forum_bump_scheduler_halted",
      "forum_bump_scheduler_unexpected_failed",
    ];
    for (const key of keys) {
      try {
        await alertNotifier.notifyRecovery(key, `Forum Bump 已恢复健康：${key}`);
      } catch (error) {
        try {
          logger?.error?.("[ForumBumpRuntime] recovery 告警失败", {
            incidentKey: key,
            errorName: typeof error?.name === "string" ? error.name : "Error",
          });
        } catch {
          // ignore
        }
        throw error;
      }
    }
  }

  return {
    handleCycleResult,
    notifyHealthyRecoveries,
    mapCycleResultToIncidentKey,
  };
}
