/**
 * Forum Bump 串行限速调度器（环境无关、可离线测试）。
 *
 * 不接入 bot.js / Alert Outbox；不自动 initialize 状态。
 * 所有 State Store 写操作结果必须检查；失败 fail-closed。
 */

import {
  getLocalDate,
  toUtcIso,
} from "./businessTime.js";
import {
  computeJitterMs,
  computeNextEligibleAtMs,
  computeTimerDelayMs,
  decideNextWakeAt,
  formatSuccessAtIso,
  successLocalDate,
} from "./schedulerDecision.js";
import { validateSchedulerConfig } from "./schedulerConfig.js";
import { buildSafeInFlightSummary } from "./runtimeAlerts.js";

function buildSafeInFlightSummaryFromState(state) {
  return buildSafeInFlightSummary(state?.inFlight ?? null);
}

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  };
}

function defaultRandom() {
  return Math.random();
}

function defaultCreateOperationId() {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 安全调用 State Store：同时处理 {success:false} 与 throw。
 * Store 自带合法 errorCode 优先于 fallback。
 * @param {() => Promise<object>} fn
 * @param {string} [fallbackErrorCode="STATE_WRITE_FAILED"]
 * @returns {Promise<{ ok: boolean, result: object|null, errorCode: string|null }>}
 */
export async function safeStateCall(fn, fallbackErrorCode = "STATE_WRITE_FAILED") {
  try {
    const result = await fn();
    if (!result || result.success !== true) {
      return {
        ok: false,
        result: result ?? null,
        errorCode: (typeof result?.errorCode === "string" && result.errorCode)
          ? result.errorCode
          : fallbackErrorCode,
      };
    }
    return { ok: true, result, errorCode: null };
  } catch (error) {
    const fromCode = typeof error?.code === "string" && error.code
      ? error.code
      : null;
    const fromErrorCode = typeof error?.errorCode === "string" && error.errorCode
      ? error.errorCode
      : null;
    return {
      ok: false,
      result: null,
      errorCode: fromCode || fromErrorCode || fallbackErrorCode,
    };
  }
}

function haltNoTimer(status, errorCode, extra = {}) {
  return {
    success: false,
    status,
    errorCode,
    nextWakeAt: null,
    ...extra,
  };
}

/**
 * @param {object} deps
 */
export function createForumBumpScheduler({
  scanCandidates,
  bumpService,
  stateStore,
  logger,
  clock = { now: () => Date.now() },
  timers = defaultTimers(),
  random = defaultRandom,
  createOperationId = defaultCreateOperationId,
  onCycleResult = null,
  config: rawConfig,
} = {}) {
  if (typeof scanCandidates !== "function") {
    throw new TypeError("createForumBumpScheduler 需要 scanCandidates");
  }
  if (!bumpService || typeof bumpService.bumpThread !== "function") {
    throw new TypeError("createForumBumpScheduler 需要 bumpService");
  }
  if (!stateStore) {
    throw new TypeError("createForumBumpScheduler 需要 stateStore");
  }

  /** 可热替换的调度配置（validate 后的规范化对象） */
  let config = validateSchedulerConfig(rawConfig);

  function emitCycleResult(result) {
    if (typeof onCycleResult !== "function") return;
    try {
      const ret = onCycleResult(result);
      if (ret && typeof ret.then === "function") {
        ret.catch((error) => {
          try {
            logger?.error?.("[ForumBumpScheduler] onCycleResult async failed", {
              errorName: typeof error?.name === "string" ? error.name : "Error",
            });
          } catch {
            // ignore
          }
        });
      }
    } catch (error) {
      try {
        logger?.error?.("[ForumBumpScheduler] onCycleResult failed", {
          errorName: typeof error?.name === "string" ? error.name : "Error",
        });
      } catch {
        // ignore
      }
    }
  }

  let started = false;
  let stopping = false;
  let running = false;
  let nextWakeAt = null;
  let timerHandle = null;
  let timerGeneration = 0;
  let currentOperationId = null;
  let lastRunStatus = null;
  let currentAbort = null;
  let runPromise = null;

  function getStatus() {
    return {
      started,
      stopping,
      running,
      nextWakeAt,
      currentOperationId,
      lastRunStatus,
    };
  }

  function clearTimer() {
    if (timerHandle != null) {
      try {
        timers.clearTimeout(timerHandle);
      } catch {
        // ignore
      }
    }
    timerHandle = null;
  }

  function invalidateTimer() {
    timerGeneration += 1;
    clearTimer();
  }

  function clearSchedule() {
    invalidateTimer();
    nextWakeAt = null;
  }

  function logTimerUnexpected(error) {
    try {
      logger?.error?.("[ForumBumpScheduler] timer unexpected", {
        errorCode: typeof error?.code === "string" ? error.code : "SCHEDULER_UNEXPECTED_FAILED",
        errorName: typeof error?.name === "string" ? error.name : "Error",
      });
    } catch {
      // ignore
    }
  }

  /**
   * Timer 基础设施异常。
   * @param {unknown} error
   * @param {{ emitResult?: boolean }} [opts]
   *   emitResult=true：Timer 回调入口外层失败，需 emit 一次（runOnce 尚未运行）
   *   emitResult=false：runOnce 内 arm 失败，由 runOnce 结束统一 emit，避免重复
   */
  function handleTimerUnexpected(error, opts = {}) {
    const emitResult = opts.emitResult === true;
    logTimerUnexpected(error);
    clearSchedule();
    lastRunStatus = "unexpected_failed";
    const result = {
      success: false,
      status: "unexpected_failed",
      errorCode: "SCHEDULER_UNEXPECTED_FAILED",
      nextWakeAt: null,
      source: "timer",
    };
    if (emitResult) {
      emitCycleResult(result);
    }
    return result;
  }

  /**
   * 安排下一次唤醒。失败时抛出，由调用方 fail-closed。
   * @returns {{ ok: true } | never}
   */
  function scheduleWake(targetMs, reason) {
    if (stopping || !started) {
      clearSchedule();
      return { ok: true };
    }
    if (targetMs == null) {
      clearSchedule();
      return { ok: true };
    }

    const now = clock.now();
    const delay = computeTimerDelayMs(now, targetMs);
    if (delay == null) {
      clearSchedule();
      return { ok: true };
    }

    invalidateTimer();
    const gen = timerGeneration;
    const plannedWake = targetMs;
    nextWakeAt = plannedWake;

    const callback = () => {
      Promise.resolve()
        .then(async () => {
          // 本回调已消费 handle
          if (gen === timerGeneration) {
            timerHandle = null;
          }
          if (gen !== timerGeneration) return;

          const n = clock.now();
          if (plannedWake != null && n + 50 < plannedWake) {
            // 提前触发：重新 arm，不启动周期
            scheduleWake(plannedWake, reason);
            return;
          }
          await runOnce();
        })
        .catch((error) => {
          // runOnce 路径内异常已由 runOnce emit；此处覆盖 runOnce 之前的入口异常
          // 若 error 来自 runOnce 内部已 emit 的路径：runOnce 不 throw（边界化）
          // 因此此处均为 Timer 入口 / early re-arm 异常 → 需要 emit
          handleTimerUnexpected(error, { emitResult: true });
        });
    };

    try {
      timerHandle = timers.setTimeout(callback, delay);
    } catch (error) {
      // setTimeout 失败：不得保留 nextWakeAt / 失效 handle
      timerHandle = null;
      nextWakeAt = null;
      throw error;
    }

    try {
      logger?.info?.("[ForumBumpScheduler] timer scheduled", {
        reason,
        nextWakeAt: toUtcIso(targetMs),
        delayMs: delay,
      });
    } catch {
      // ignore logging failure
    }
    return { ok: true };
  }

  /**
   * @returns {{ ok: boolean, errorCode?: string }}
   */
  function armFromDecision(decision) {
    try {
      if (!decision || decision.nextWakeAt == null) {
        clearSchedule();
        return { ok: true };
      }
      scheduleWake(decision.nextWakeAt, decision.reason);
      return { ok: true };
    } catch (error) {
      // runOnce / armAfterBusiness 路径：不在此 emit，由 runOnce 返回后统一 emit
      // start 首次 arm：不 emit 周期结果（由 Runtime 处理 startResult）
      handleTimerUnexpected(error, { emitResult: false });
      return { ok: false, errorCode: "SCHEDULER_UNEXPECTED_FAILED" };
    }
  }

  async function loadStateOrFail() {
    const call = await safeStateCall(() => stateStore.load(), "STATE_READ_FAILED");
    if (!call.ok) {
      return { ok: false, errorCode: call.errorCode || "STATE_READ_FAILED", state: null };
    }
    return { ok: true, state: call.result.state, errorCode: null };
  }

  /**
   * 普通退避路径：deferUntil 必须成功，否则 state_failed。
   */
  async function deferOrStateFailed(revision, delayMs, primaryErrorCode = null) {
    const nextEligibleAt = toUtcIso(clock.now() + delayMs);
    const def = await safeStateCall(() => stateStore.deferUntil({
      expectedRevision: revision,
      nextEligibleAt,
    }), "STATE_WRITE_FAILED");
    if (!def.ok) {
      clearSchedule();
      return {
        ok: false,
        response: haltNoTimer("state_failed", def.errorCode, {
          primaryErrorCode,
          stateErrorCode: def.errorCode,
        }),
      };
    }
    return {
      ok: true,
      state: def.result.state,
      revision: def.result.revision,
    };
  }

  /**
   * 高风险 pause：失败则 state_failed，不得声称 paused。
   */
  async function pauseOrStateFailed(revision, reason, primaryErrorCode) {
    const p = await safeStateCall(() => stateStore.pause({
      expectedRevision: revision,
      reason,
    }), "STATE_WRITE_FAILED");
    clearSchedule();
    if (!p.ok) {
      return haltNoTimer("state_failed", p.errorCode, {
        primaryErrorCode: primaryErrorCode || reason,
        stateErrorCode: p.errorCode,
      });
    }
    return {
      success: false,
      status: reason === "BUMP_DELETE_FAILED" || primaryErrorCode === "DELETE_FAILED"
        ? "cleanup_required"
        : "halted",
      errorCode: primaryErrorCode || reason,
      nextWakeAt: null,
      state: p.result.state,
    };
  }

  /**
   * 周期业务已完成后 arm 下一次 timer；arm 失败则 fail-closed，不回滚磁盘业务状态。
   */
  function armAfterBusiness(decision, businessResult) {
    const arm = armFromDecision(decision);
    if (!arm.ok) {
      return haltNoTimer("unexpected_failed", "SCHEDULER_UNEXPECTED_FAILED", {
        businessStatus: businessResult?.status ?? null,
        businessErrorCode: businessResult?.errorCode ?? null,
      });
    }
    return {
      ...businessResult,
      nextWakeAt: decision?.nextWakeAt ?? null,
    };
  }

  async function start() {
    if (started) {
      return { success: false, errorCode: "SCHEDULER_ALREADY_STARTED" };
    }
    stopping = false;
    running = false;
    currentOperationId = null;
    currentAbort = null;
    runPromise = null;
    clearSchedule();

    const loaded = await safeStateCall(() => stateStore.load(), "STATE_READ_FAILED");
    if (!loaded.ok) {
      return {
        success: false,
        errorCode: loaded.errorCode || "STATE_NOT_FOUND",
        recoveryStatus: null,
        timerArmed: false,
        nextWakeAt: null,
      };
    }

    const recovery = await safeStateCall(
      () => stateStore.recoverOnStartup(),
      "STATE_RECOVERY_FAILED",
    );
    if (!recovery.ok) {
      return {
        success: false,
        errorCode: recovery.errorCode || "STATE_RECOVERY_FAILED",
        recoveryStatus: null,
        timerArmed: false,
        nextWakeAt: null,
      };
    }

    const recoveryResult = recovery.result;
    if (recoveryResult.recoveryStatus && recoveryResult.recoveryStatus !== "clean") {
      started = true;
      lastRunStatus = "recovery_required";
      clearSchedule();
      const recState = recoveryResult.state || loaded.result.state;
      const inFlightSummary = buildSafeInFlightSummaryFromState(recState);
      return {
        success: true,
        started: true,
        recoveryStatus: recoveryResult.recoveryStatus,
        cleanupRequired: recoveryResult.cleanupRequired,
        errorCode: null,
        timerArmed: false,
        nextWakeAt: null,
        inFlightSummary,
      };
    }

    const state = recoveryResult.state || loaded.result.state;
    if (state.paused) {
      started = true;
      lastRunStatus = "paused";
      clearSchedule();
      return {
        success: true,
        started: true,
        recoveryStatus: "clean",
        errorCode: null,
        timerArmed: false,
        nextWakeAt: null,
        inFlightSummary: buildSafeInFlightSummaryFromState(state),
        pauseReason: state.pauseReason ?? null,
      };
    }

    if (!config.enabled) {
      started = true;
      lastRunStatus = "disabled";
      clearSchedule();
      return {
        success: true,
        started: true,
        recoveryStatus: "clean",
        errorCode: null,
        timerArmed: false,
        nextWakeAt: null,
      };
    }

    // 先标记 started，arm 失败则回滚到未启动，避免“假启动无闹钟”
    started = true;
    let decision;
    try {
      decision = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "start",
      });
    } catch (error) {
      started = false;
      clearSchedule();
      logTimerUnexpected(error);
      return {
        success: false,
        errorCode: "SCHEDULER_UNEXPECTED_FAILED",
        timerArmed: false,
        nextWakeAt: null,
        started: false,
      };
    }

    const arm = armFromDecision(decision);
    if (!arm.ok) {
      started = false;
      clearSchedule();
      return {
        success: false,
        errorCode: "SCHEDULER_UNEXPECTED_FAILED",
        timerArmed: false,
        nextWakeAt: null,
        started: false,
      };
    }

    return {
      success: true,
      started: true,
      recoveryStatus: "clean",
      errorCode: null,
      timerArmed: decision.nextWakeAt != null,
      nextWakeAt: decision.nextWakeAt,
    };
  }

  async function stop() {
    stopping = true;
    clearSchedule();
    if (currentAbort && typeof currentAbort.abort === "function") {
      try {
        currentAbort.abort();
      } catch {
        // ignore
      }
    }
    // 必须等待当前周期（含 handleUnexpected）完成
    if (runPromise) {
      try {
        await runPromise;
      } catch {
        // runOnce 已边界化
      }
    }
    started = false;
    stopping = false;
    running = false;
    currentOperationId = null;
    currentAbort = null;
    runPromise = null;
    return { success: true };
  }

  async function runOnce() {
    if (!started) {
      lastRunStatus = "not_started";
      return { success: false, status: "not_started", errorCode: "SCHEDULER_NOT_STARTED", nextWakeAt: null };
    }
    if (stopping) {
      lastRunStatus = "stopping";
      return { success: false, status: "stopping", errorCode: "SCHEDULER_STOPPING", nextWakeAt: null };
    }
    if (running) {
      lastRunStatus = "busy";
      return { success: false, status: "busy", errorCode: "SCHEDULER_BUSY", nextWakeAt: null };
    }

    running = true;
    // runPromise 必须覆盖 executeCycle 与 handleUnexpected 的完整过程
    const cycle = (async () => {
      let result;
      try {
        result = await executeCycle();
      } catch (error) {
        result = await handleUnexpected(error);
      } finally {
        // 仅在完整结束后释放 single-flight
        running = false;
        currentOperationId = null;
        currentAbort = null;
        runPromise = null;
      }
      return result;
    })();
    runPromise = cycle;
    const result = await cycle;
    lastRunStatus = result?.status ?? "unexpected_failed";
    // 手动 runOnce 与 Timer 触发路径均汇聚于此
    emitCycleResult(result);
    return result;
  }

  async function handleUnexpected(error) {
    try {
      logger?.error?.("[ForumBumpScheduler] unexpected failure", {
        errorCode: typeof error?.code === "string" ? error.code : "SCHEDULER_UNEXPECTED_FAILED",
        errorName: typeof error?.name === "string" ? error.name : "Error",
      });
    } catch {
      // ignore
    }
    clearSchedule();

    const load = await loadStateOrFail();
    if (!load.ok) {
      return haltNoTimer("state_failed", load.errorCode || "STATE_READ_FAILED");
    }
    if (load.state?.inFlight) {
      const paused = await pauseOrStateFailed(
        load.state.revision,
        "BUMP_UNEXPECTED_FAILED",
        "SCHEDULER_UNEXPECTED_FAILED",
      );
      if (paused.status === "state_failed") {
        return paused;
      }
      // pause 成功：保留 inFlight，停止自动调度
      return haltNoTimer("unexpected_failed", "SCHEDULER_UNEXPECTED_FAILED", {
        sentMessageId: load.state.inFlight.sentMessageId ?? null,
      });
    }
    return haltNoTimer("unexpected_failed", "SCHEDULER_UNEXPECTED_FAILED");
  }

  async function executeCycle() {
    const load = await loadStateOrFail();
    if (!load.ok) {
      clearSchedule();
      return haltNoTimer("state_failed", load.errorCode);
    }
    let state = load.state;
    let revision = state.revision;

    if (state.inFlight) {
      clearSchedule();
      return haltNoTimer("recovery_required", "STATE_RECOVERY_REQUIRED");
    }
    if (state.paused) {
      clearSchedule();
      return { success: true, status: "paused", errorCode: null, nextWakeAt: null };
    }

    const nowMs = clock.now();
    const localDate = getLocalDate(nowMs, config.timezone);
    if (localDate < state.localDate) {
      clearSchedule();
      return haltNoTimer("state_failed", "STATE_DATE_ROLLBACK");
    }
    if (localDate > state.localDate) {
      const roll = await safeStateCall(() => stateStore.rolloverLocalDate({
        expectedRevision: revision,
        localDate,
      }), "STATE_WRITE_FAILED");
      if (!roll.ok) {
        clearSchedule();
        return haltNoTimer("state_failed", roll.errorCode);
      }
      state = roll.result.state;
      revision = roll.result.revision;
    }

    if (!config.enabled) {
      clearSchedule();
      return { success: true, status: "disabled", errorCode: null, nextWakeAt: null };
    }

    const gate = decideNextWakeAt({
      nowMs: clock.now(),
      config,
      state,
      reason: "ready",
    });
    if (gate.reason === "outside_window" || gate.reason === "daily_limit" || gate.reason === "cooldown") {
      return armAfterBusiness(gate, {
        success: true,
        status: gate.reason,
        errorCode: null,
      });
    }

    if (stopping) {
      return { success: false, status: "stopping", errorCode: "SCHEDULER_STOPPING", nextWakeAt: null };
    }

    let scanReport;
    try {
      scanReport = await scanCandidates({
        guildId: config.guildId,
        forumIds: config.forumChannelIds,
        silenceDays: config.silenceDays,
        excludedTagIds: config.excludedTagIds,
        skipPinned: config.skipPinned,
        displayLimit: 1,
        clock,
      });
    } catch (error) {
      const def = await deferOrStateFailed(
        revision,
        config.failureBackoffMs,
        typeof error?.code === "string" ? error.code : "SCAN_FAILED",
      );
      if (!def.ok) return def.response;
      state = def.state;
      revision = def.revision;
      const d = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "failure_backoff",
      });
      return armAfterBusiness(d, {
        success: false,
        status: "scan_failed",
        errorCode: typeof error?.code === "string" ? error.code : "SCAN_FAILED",
      });
    }

    const candidates = scanReport?.candidates
      || scanReport?._allEligibleSorted
      || [];
    const first = candidates[0] || null;
    if (!first) {
      const def = await deferOrStateFailed(revision, config.idlePollMs);
      if (!def.ok) return def.response;
      state = def.state;
      revision = def.revision;
      const d = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "no_candidate",
      });
      return armAfterBusiness(d, {
        success: true,
        status: "no_candidate",
        errorCode: null,
      });
    }

    if (stopping) {
      return { success: false, status: "stopping", errorCode: "SCHEDULER_STOPPING", nextWakeAt: null };
    }

    // Dry Run：报告第一候选，仅 deferUntil，不 beginInFlight / 不 Bump
    if (config.mode === "dry_run") {
      const def = await deferOrStateFailed(revision, config.idlePollMs);
      if (!def.ok) return def.response;
      state = def.state;
      revision = def.revision;
      const d = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "no_candidate",
      });
      return armAfterBusiness(d, {
        success: true,
        status: "dry_run_candidate",
        errorCode: null,
        candidate: {
          threadId: first.threadId ?? null,
          forumChannelId: first.forumChannelId ?? null,
          guildId: first.guildId ?? config.guildId,
        },
      });
    }

    const operationId = createOperationId();
    currentOperationId = operationId;
    let abortController = null;
    if (typeof AbortController === "function") {
      abortController = new AbortController();
      currentAbort = abortController;
    }

    let lifecycleRevision = revision;
    const lifecycle = {
      onBeforeSend: async () => {
        const startedAt = toUtcIso(clock.now());
        const call = await safeStateCall(() => stateStore.beginInFlight({
          expectedRevision: lifecycleRevision,
          operationId,
          guildId: config.guildId,
          forumChannelId: first.forumChannelId,
          threadId: first.threadId,
          startedAt,
        }), "STATE_WRITE_FAILED");
        if (!call.ok) {
          const err = new Error(call.errorCode || "STATE_WRITE_FAILED");
          err.code = call.errorCode || "STATE_WRITE_FAILED";
          throw err;
        }
        lifecycleRevision = call.result.revision;
      },
      onMessageSent: async ({ sentMessageId }) => {
        const sentAt = toUtcIso(clock.now());
        const call = await safeStateCall(() => stateStore.markMessageSent({
          expectedRevision: lifecycleRevision,
          operationId,
          sentMessageId,
          sentAt,
        }), "STATE_WRITE_FAILED");
        if (!call.ok) {
          const err = new Error(call.errorCode || "STATE_WRITE_FAILED");
          err.code = call.errorCode || "STATE_WRITE_FAILED";
          throw err;
        }
        lifecycleRevision = call.result.revision;
      },
      onMessageDeleted: async () => {
        const deletedAt = toUtcIso(clock.now());
        const call = await safeStateCall(() => stateStore.markMessageDeleted({
          expectedRevision: lifecycleRevision,
          operationId,
          deletedAt,
        }), "STATE_WRITE_FAILED");
        if (!call.ok) {
          const err = new Error(call.errorCode || "STATE_WRITE_FAILED");
          err.code = call.errorCode || "STATE_WRITE_FAILED";
          throw err;
        }
        lifecycleRevision = call.result.revision;
      },
    };

    const bumpResult = await bumpService.bumpThread({
      guildId: config.guildId,
      forumChannelId: first.forumChannelId,
      threadId: first.threadId,
      policy: {
        silenceDays: config.silenceDays,
        excludedTagIds: config.excludedTagIds,
        skipPinned: config.skipPinned,
      },
      signal: abortController?.signal,
      lifecycle,
    });

    const after = await loadStateOrFail();
    if (after.ok) {
      state = after.state;
      revision = state.revision;
    } else {
      // 若 bump 后状态不可读，fail closed
      clearSchedule();
      return haltNoTimer("state_failed", after.errorCode);
    }

    if (bumpResult.status === "skipped") {
      const def = await deferOrStateFailed(revision, config.idlePollMs, bumpResult.errorCode);
      if (!def.ok) return def.response;
      state = def.state;
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "skipped",
      });
      return armAfterBusiness(d, {
        success: true,
        status: "skipped",
        errorCode: bumpResult.errorCode,
        skipReason: bumpResult.skipReason,
      });
    }

    if (bumpResult.status === "cancelled" || bumpResult.errorCode === "BUMP_ABORTED") {
      if (state?.inFlight?.phase === "before_send"
        && state.inFlight.operationId === operationId) {
        const ab = await safeStateCall(() => stateStore.abandonBeforeSend({
          expectedRevision: revision,
          operationId,
        }), "STATE_WRITE_FAILED");
        if (!ab.ok) {
          clearSchedule();
          return haltNoTimer("state_failed", ab.errorCode, {
            primaryErrorCode: bumpResult.errorCode,
            stateErrorCode: ab.errorCode,
          });
        }
        state = ab.result.state;
        revision = ab.result.revision;
      }
      if (stopping) {
        clearSchedule();
        return { success: true, status: "stopped", errorCode: null, nextWakeAt: null };
      }
      const def = await deferOrStateFailed(revision, config.failureBackoffMs, bumpResult.errorCode);
      if (!def.ok) return def.response;
      state = def.state;
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "failure_backoff",
      });
      return armAfterBusiness(d, {
        success: true,
        status: "cancelled",
        errorCode: bumpResult.errorCode,
      });
    }

    if (bumpResult.errorCode === "LIFECYCLE_BEFORE_SEND_FAILED") {
      clearSchedule();
      return haltNoTimer("state_failed", "LIFECYCLE_BEFORE_SEND_FAILED");
    }

    if (bumpResult.errorCode === "SEND_FAILED") {
      if (state?.inFlight?.phase === "before_send"
        && state.inFlight.operationId === operationId) {
        const ab = await safeStateCall(() => stateStore.abandonBeforeSend({
          expectedRevision: revision,
          operationId,
        }), "STATE_WRITE_FAILED");
        if (!ab.ok) {
          clearSchedule();
          return haltNoTimer("state_failed", ab.errorCode, {
            primaryErrorCode: "SEND_FAILED",
            stateErrorCode: ab.errorCode,
          });
        }
        state = ab.result.state;
        revision = ab.result.revision;
      }
      const def = await deferOrStateFailed(revision, config.failureBackoffMs, "SEND_FAILED");
      if (!def.ok) return def.response;
      state = def.state;
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "failure_backoff",
      });
      return armAfterBusiness(d, {
        success: false,
        status: "send_failed",
        errorCode: "SEND_FAILED",
      });
    }

    if (bumpResult.cleanupRequired || bumpResult.errorCode === "DELETE_FAILED") {
      const paused = await pauseOrStateFailed(
        revision,
        "BUMP_DELETE_FAILED",
        "DELETE_FAILED",
      );
      if (paused.status === "state_failed") return paused;
      return {
        success: false,
        status: "cleanup_required",
        errorCode: "DELETE_FAILED",
        sentMessageId: bumpResult.sentMessageId,
        nextWakeAt: null,
      };
    }

    if (bumpResult.errorCode === "SEND_RESULT_INVALID"
      || bumpResult.errorCode === "LIFECYCLE_AFTER_SEND_FAILED") {
      const paused = await pauseOrStateFailed(
        revision,
        bumpResult.errorCode,
        bumpResult.errorCode,
      );
      if (paused.status === "state_failed") return paused;
      return {
        success: false,
        status: "halted",
        errorCode: bumpResult.errorCode,
        nextWakeAt: null,
      };
    }

    if (bumpResult.errorCode === "LIFECYCLE_AFTER_DELETE_FAILED") {
      const paused = await pauseOrStateFailed(
        revision,
        "LIFECYCLE_AFTER_DELETE_FAILED",
        "LIFECYCLE_AFTER_DELETE_FAILED",
      );
      if (paused.status === "state_failed") return paused;
      return {
        success: false,
        status: "halted",
        errorCode: "LIFECYCLE_AFTER_DELETE_FAILED",
        nextWakeAt: null,
      };
    }

    if (bumpResult.success === true && bumpResult.status === "succeeded") {
      const successAtMs = clock.now();
      const successAt = formatSuccessAtIso(successAtMs);
      // 成功间隔 = 自动间隔（cooldownMs）；抖动为 0 时不调用 random，避免无意义故障面
      let jitterMs = 0;
      if (config.cooldownJitterMs > 0) {
        let randomValue;
        try {
          randomValue = random();
        } catch {
          const paused = await pauseOrStateFailed(
            revision,
            "SCHEDULER_RANDOM_INVALID",
            "SCHEDULER_RANDOM_INVALID",
          );
          if (paused.status === "state_failed") return paused;
          return {
            success: false,
            status: "halted",
            errorCode: "SCHEDULER_RANDOM_INVALID",
            nextWakeAt: null,
          };
        }
        const jitter = computeJitterMs(randomValue, config.cooldownJitterMs);
        if (!jitter.ok) {
          const paused = await pauseOrStateFailed(
            revision,
            "SCHEDULER_RANDOM_INVALID",
            "SCHEDULER_RANDOM_INVALID",
          );
          if (paused.status === "state_failed") return paused;
          return {
            success: false,
            status: "halted",
            errorCode: "SCHEDULER_RANDOM_INVALID",
            nextWakeAt: null,
          };
        }
        jitterMs = jitter.jitterMs;
      }
      const nextEligibleMs = computeNextEligibleAtMs(
        successAtMs,
        config.cooldownMs,
        jitterMs,
      );
      const nextEligibleAt = toUtcIso(nextEligibleMs);
      const doneLocalDate = successLocalDate(successAtMs, config.timezone);

      const latest = await loadStateOrFail();
      if (!latest.ok) {
        clearSchedule();
        return haltNoTimer("state_failed", latest.errorCode);
      }
      revision = latest.state.revision;

      const complete = await safeStateCall(() => stateStore.completeSuccess({
        expectedRevision: revision,
        operationId,
        localDate: doneLocalDate,
        successAt,
        nextEligibleAt,
      }), "STATE_WRITE_FAILED");
      if (!complete.ok) {
        // Discord 已成功、磁盘停留 after_delete：禁止伪装成功；pause 后需人工对账
        const primary = complete.errorCode || "STATE_WRITE_FAILED";
        const paused = await pauseOrStateFailed(revision, primary, primary);
        if (paused.status === "state_failed") return paused;
        return {
          success: false,
          status: "reconciliation_required",
          errorCode: primary,
          primaryErrorCode: primary,
          nextWakeAt: null,
        };
      }
      state = complete.result.state;
      const cool = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "cooldown",
      });
      return armAfterBusiness(cool, {
        success: true,
        status: "succeeded",
        errorCode: null,
        sentMessageId: bumpResult.sentMessageId,
        diagnosticsComplete: bumpResult.diagnosticsComplete,
      });
    }

    // generic failure before inflight
    if (!state?.inFlight) {
      const def = await deferOrStateFailed(
        revision,
        config.failureBackoffMs,
        bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
      );
      if (!def.ok) return def.response;
      state = def.state;
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "failure_backoff",
      });
      return armAfterBusiness(d, {
        success: false,
        status: "failed",
        errorCode: bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
      });
    }

    // unknown with inflight
    const paused = await pauseOrStateFailed(
      revision,
      bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
      bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
    );
    if (paused.status === "state_failed") return paused;
    return {
      success: false,
      status: "halted",
      errorCode: bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
      nextWakeAt: null,
    };
  };

  /**
   * 等待当前 runOnce / 异常恢复结束（不取消进行中的 send/delete）。
   */
  async function waitUntilIdle() {
    if (runPromise) {
      try {
        await runPromise;
      } catch {
        // ignore
      }
    }
  }

  function getConfig() {
    return { ...config, forumChannelIds: [...config.forumChannelIds], excludedTagIds: [...config.excludedTagIds] };
  }

  /**
   * 热替换调度配置（调用方负责在 idle 后调用）。
   * @param {object} nextRaw
   */
  function replaceConfig(nextRaw) {
    config = validateSchedulerConfig(nextRaw);
    return getConfig();
  }

  /**
   * 按当前配置与磁盘状态清除旧 timer 并重新 arm。
   * paused / recovery 则无 timer。
   */
  async function rescheduleFromState({ reason = "ready" } = {}) {
    if (!started || stopping) {
      clearSchedule();
      return { success: true, timerArmed: false, nextWakeAt: null, reason: "not_started" };
    }
    const loaded = await loadStateOrFail();
    if (!loaded.ok) {
      clearSchedule();
      lastRunStatus = "state_failed";
      return {
        success: false,
        timerArmed: false,
        nextWakeAt: null,
        errorCode: loaded.errorCode,
        reason: "state_failed",
      };
    }
    const state = loaded.state;
    if (state.paused) {
      clearSchedule();
      return {
        success: true,
        timerArmed: false,
        nextWakeAt: null,
        reason: "paused",
        pauseReason: state.pauseReason ?? null,
      };
    }
    if (state.inFlight) {
      clearSchedule();
      return {
        success: true,
        timerArmed: false,
        nextWakeAt: null,
        reason: "in_flight",
      };
    }
    const decision = decideNextWakeAt({
      nowMs: clock.now(),
      config,
      state,
      reason,
    });
    if (decision.nextWakeAt == null) {
      clearSchedule();
      return { success: true, timerArmed: false, nextWakeAt: null, reason: decision.reason };
    }
    try {
      const armed = armFromDecision(decision);
      if (!armed.ok) {
        clearSchedule();
        lastRunStatus = "unexpected_failed";
        return {
          success: false,
          timerArmed: false,
          nextWakeAt: null,
          errorCode: "SCHEDULER_UNEXPECTED_FAILED",
          reason: "arm_failed",
        };
      }
      return {
        success: true,
        timerArmed: true,
        nextWakeAt: decision.nextWakeAt,
        reason: decision.reason,
      };
    } catch {
      clearSchedule();
      lastRunStatus = "unexpected_failed";
      return {
        success: false,
        timerArmed: false,
        nextWakeAt: null,
        errorCode: "SCHEDULER_UNEXPECTED_FAILED",
        reason: "arm_failed",
      };
    }
  }

  return {
    start,
    stop,
    runOnce,
    getStatus,
    getConfig,
    replaceConfig,
    waitUntilIdle,
    rescheduleFromState,
    clearSchedule,
  };
}
