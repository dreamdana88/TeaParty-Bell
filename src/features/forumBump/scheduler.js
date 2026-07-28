/**
 * Forum Bump 串行限速调度器（环境无关、可离线测试）。
 *
 * 不接入 bot.js / Alert Outbox；不自动 initialize 状态。
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
import { isValidIsoTimestamp } from "./stateSchema.js";

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

  const config = validateSchedulerConfig(rawConfig);

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

  function scheduleWake(targetMs, reason) {
    if (stopping || !started) {
      nextWakeAt = null;
      clearTimer();
      return;
    }
    if (targetMs == null) {
      nextWakeAt = null;
      clearTimer();
      return;
    }
    const now = clock.now();
    nextWakeAt = targetMs;
    const delay = computeTimerDelayMs(now, targetMs);
    if (delay == null) {
      clearTimer();
      return;
    }
    invalidateTimer();
    const gen = timerGeneration;
    timerHandle = timers.setTimeout(() => {
      if (gen !== timerGeneration) return;
      // 中间唤醒：若尚未到点，重新分段
      const n = clock.now();
      if (nextWakeAt != null && n + 50 < nextWakeAt) {
        scheduleWake(nextWakeAt, reason);
        return;
      }
      runOnce().catch(() => {});
    }, delay);
    try {
      logger?.info?.("[ForumBumpScheduler] timer scheduled", {
        reason,
        nextWakeAt: toUtcIso(targetMs),
        delayMs: delay,
      });
    } catch {
      // ignore
    }
  }

  function armFromDecision(decision) {
    if (!decision || decision.nextWakeAt == null) {
      invalidateTimer();
      nextWakeAt = null;
      return;
    }
    scheduleWake(decision.nextWakeAt, decision.reason);
  }

  async function loadStateOrFail() {
    const loaded = await stateStore.load();
    if (!loaded.success) {
      return { ok: false, errorCode: loaded.errorCode || "STATE_READ_FAILED", state: null };
    }
    return { ok: true, state: loaded.state, errorCode: null };
  }

  async function start() {
    if (started) {
      return { success: false, errorCode: "SCHEDULER_ALREADY_STARTED" };
    }
    stopping = false;

    // config 已在工厂校验
    const loaded = await stateStore.load();
    if (!loaded.success) {
      return {
        success: false,
        errorCode: loaded.errorCode || "STATE_NOT_FOUND",
        recoveryStatus: null,
      };
    }

    const recovery = await stateStore.recoverOnStartup();
    if (!recovery.success) {
      return {
        success: false,
        errorCode: recovery.errorCode || "STATE_READ_FAILED",
        recoveryStatus: null,
      };
    }

    if (recovery.recoveryStatus && recovery.recoveryStatus !== "clean") {
      started = true;
      lastRunStatus = "recovery_required";
      return {
        success: true,
        started: true,
        recoveryStatus: recovery.recoveryStatus,
        cleanupRequired: recovery.cleanupRequired,
        errorCode: null,
        timerArmed: false,
      };
    }

    const state = recovery.state || loaded.state;
    if (state.paused) {
      started = true;
      lastRunStatus = "paused";
      return {
        success: true,
        started: true,
        recoveryStatus: "clean",
        errorCode: null,
        timerArmed: false,
      };
    }

    if (!config.enabled) {
      started = true;
      lastRunStatus = "disabled";
      return {
        success: true,
        started: true,
        recoveryStatus: "clean",
        errorCode: null,
        timerArmed: false,
      };
    }

    started = true;
    const decision = decideNextWakeAt({
      nowMs: clock.now(),
      config,
      state,
      reason: "start",
    });
    armFromDecision(decision);
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
    invalidateTimer();
    nextWakeAt = null;
    if (currentAbort && typeof currentAbort.abort === "function") {
      try {
        currentAbort.abort();
      } catch {
        // ignore
      }
    }
    if (runPromise) {
      try {
        await runPromise;
      } catch {
        // ignore
      }
    }
    started = false;
    stopping = false;
    running = false;
    currentOperationId = null;
    return { success: true };
  }

  async function runOnce() {
    if (!started) {
      lastRunStatus = "not_started";
      return { success: false, status: "not_started", errorCode: "SCHEDULER_NOT_STARTED" };
    }
    if (stopping) {
      lastRunStatus = "stopping";
      return { success: false, status: "stopping", errorCode: "SCHEDULER_STOPPING" };
    }
    if (running) {
      lastRunStatus = "busy";
      return { success: false, status: "busy", errorCode: "SCHEDULER_BUSY" };
    }

    running = true;
    const cycle = (async () => {
      try {
        return await executeCycle();
      } finally {
        running = false;
        currentOperationId = null;
        currentAbort = null;
      }
    })();
    runPromise = cycle;
    const result = await cycle;
    runPromise = null;
    lastRunStatus = result.status;
    return result;
  }

  async function executeCycle() {
    const load = await loadStateOrFail();
    if (!load.ok) {
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return { success: false, status: "state_failed", errorCode: load.errorCode };
    }
    let state = load.state;
    let revision = state.revision;

    if (state.inFlight) {
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return {
        success: false,
        status: "recovery_required",
        errorCode: "STATE_RECOVERY_REQUIRED",
      };
    }
    if (state.paused) {
      armFromDecision({ nextWakeAt: null, reason: "paused" });
      return { success: true, status: "paused", errorCode: null };
    }

    // rollover
    const nowMs = clock.now();
    const localDate = getLocalDate(nowMs, config.timezone);
    if (localDate < state.localDate) {
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return { success: false, status: "state_failed", errorCode: "STATE_DATE_ROLLBACK" };
    }
    if (localDate > state.localDate) {
      const roll = await stateStore.rolloverLocalDate({
        expectedRevision: revision,
        localDate,
      });
      if (!roll.success) {
        armFromDecision({ nextWakeAt: null, reason: "halt" });
        return { success: false, status: "state_failed", errorCode: roll.errorCode };
      }
      state = roll.state;
      revision = roll.revision;
    }

    if (!config.enabled) {
      armFromDecision({ nextWakeAt: null, reason: "disabled" });
      return { success: true, status: "disabled", errorCode: null };
    }

    // pre-scan gates via pure decision
    const gate = decideNextWakeAt({
      nowMs: clock.now(),
      config,
      state,
      reason: "ready",
    });
    if (gate.reason === "outside_window" || gate.reason === "daily_limit" || gate.reason === "cooldown") {
      armFromDecision(gate);
      return {
        success: true,
        status: gate.reason,
        errorCode: null,
        nextWakeAt: gate.nextWakeAt,
      };
    }

    if (stopping) {
      return { success: false, status: "stopping", errorCode: "SCHEDULER_STOPPING" };
    }

    // scan
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
      const deferAt = toUtcIso(clock.now() + config.failureBackoffMs);
      await stateStore.deferUntil({
        expectedRevision: revision,
        nextEligibleAt: deferAt,
      }).catch(() => {});
      const d = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state: (await loadStateOrFail()).state || state,
        reason: "failure_backoff",
      });
      armFromDecision(d);
      return {
        success: false,
        status: "scan_failed",
        errorCode: error?.code || "SCAN_FAILED",
        nextWakeAt: d.nextWakeAt,
      };
    }

    const candidates = scanReport?.candidates
      || scanReport?._allEligibleSorted
      || [];
    const first = candidates[0] || null;
    if (!first) {
      const deferIso = toUtcIso(clock.now() + config.idlePollMs);
      const def = await stateStore.deferUntil({
        expectedRevision: revision,
        nextEligibleAt: deferIso,
      });
      if (def.success) {
        state = def.state;
        revision = def.revision;
      }
      const d = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "no_candidate",
      });
      armFromDecision(d);
      return {
        success: true,
        status: "no_candidate",
        errorCode: null,
        nextWakeAt: d.nextWakeAt,
      };
    }

    if (stopping) {
      return { success: false, status: "stopping", errorCode: "SCHEDULER_STOPPING" };
    }

    // bump with lifecycle
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
        const r = await stateStore.beginInFlight({
          expectedRevision: lifecycleRevision,
          operationId,
          guildId: config.guildId,
          forumChannelId: first.forumChannelId,
          threadId: first.threadId,
          startedAt,
        });
        if (!r.success) {
          const err = new Error(r.errorCode || "STATE_TRANSITION_INVALID");
          err.code = r.errorCode || "STATE_TRANSITION_INVALID";
          throw err;
        }
        lifecycleRevision = r.revision;
      },
      onMessageSent: async ({ sentMessageId }) => {
        const sentAt = toUtcIso(clock.now());
        const r = await stateStore.markMessageSent({
          expectedRevision: lifecycleRevision,
          operationId,
          sentMessageId,
          sentAt,
        });
        if (!r.success) {
          const err = new Error(r.errorCode || "STATE_TRANSITION_INVALID");
          err.code = r.errorCode || "STATE_TRANSITION_INVALID";
          throw err;
        }
        lifecycleRevision = r.revision;
      },
      onMessageDeleted: async () => {
        const deletedAt = toUtcIso(clock.now());
        const r = await stateStore.markMessageDeleted({
          expectedRevision: lifecycleRevision,
          operationId,
          deletedAt,
        });
        if (!r.success) {
          const err = new Error(r.errorCode || "STATE_TRANSITION_INVALID");
          err.code = r.errorCode || "STATE_TRANSITION_INVALID";
          throw err;
        }
        lifecycleRevision = r.revision;
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

    // reload revision after bump
    const after = await loadStateOrFail();
    if (after.ok) {
      state = after.state;
      revision = state.revision;
    }

    // skipped before inFlight
    if (bumpResult.status === "skipped") {
      const def = await stateStore.deferUntil({
        expectedRevision: revision,
        nextEligibleAt: toUtcIso(clock.now() + config.idlePollMs),
      });
      if (def.success) {
        state = def.state;
        revision = def.revision;
      }
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "skipped",
      });
      armFromDecision(d);
      return {
        success: true,
        status: "skipped",
        errorCode: bumpResult.errorCode,
        skipReason: bumpResult.skipReason,
        nextWakeAt: d.nextWakeAt,
      };
    }

    // cancelled before send after begin → abandon
    if (bumpResult.status === "cancelled" || bumpResult.errorCode === "BUMP_ABORTED") {
      if (state?.inFlight?.phase === "before_send"
        && state.inFlight.operationId === operationId) {
        const ab = await stateStore.abandonBeforeSend({
          expectedRevision: revision,
          operationId,
        });
        if (ab.success) {
          state = ab.state;
          revision = ab.revision;
        }
      }
      if (stopping) {
        armFromDecision({ nextWakeAt: null, reason: "halt" });
        return { success: true, status: "stopped", errorCode: null };
      }
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "failure_backoff",
      });
      armFromDecision(d);
      return {
        success: true,
        status: "cancelled",
        errorCode: bumpResult.errorCode,
        nextWakeAt: d.nextWakeAt,
      };
    }

    // lifecycle before send failed
    if (bumpResult.errorCode === "LIFECYCLE_BEFORE_SEND_FAILED") {
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return {
        success: false,
        status: "state_failed",
        errorCode: "LIFECYCLE_BEFORE_SEND_FAILED",
      };
    }

    // send failed after begin
    if (bumpResult.errorCode === "SEND_FAILED") {
      if (state?.inFlight?.phase === "before_send"
        && state.inFlight.operationId === operationId) {
        const ab = await stateStore.abandonBeforeSend({
          expectedRevision: revision,
          operationId,
        });
        if (!ab.success) {
          armFromDecision({ nextWakeAt: null, reason: "halt" });
          return {
            success: false,
            status: "state_failed",
            errorCode: ab.errorCode,
          };
        }
        state = ab.state;
        revision = ab.revision;
      }
      await stateStore.deferUntil({
        expectedRevision: revision,
        nextEligibleAt: toUtcIso(clock.now() + config.failureBackoffMs),
      });
      const reloaded = await loadStateOrFail();
      state = reloaded.state || state;
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "failure_backoff",
      });
      armFromDecision(d);
      return {
        success: false,
        status: "send_failed",
        errorCode: "SEND_FAILED",
        nextWakeAt: d.nextWakeAt,
      };
    }

    // delete failed / cleanup required
    if (bumpResult.cleanupRequired || bumpResult.errorCode === "DELETE_FAILED") {
      await stateStore.pause({
        expectedRevision: revision,
        reason: "BUMP_DELETE_FAILED",
      });
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return {
        success: false,
        status: "cleanup_required",
        errorCode: "DELETE_FAILED",
        sentMessageId: bumpResult.sentMessageId,
      };
    }

    // high risk invalid send result
    if (bumpResult.errorCode === "SEND_RESULT_INVALID"
      || bumpResult.errorCode === "LIFECYCLE_AFTER_SEND_FAILED") {
      await stateStore.pause({
        expectedRevision: revision,
        reason: bumpResult.errorCode,
      });
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return {
        success: false,
        status: "halted",
        errorCode: bumpResult.errorCode,
      };
    }

    if (bumpResult.errorCode === "LIFECYCLE_AFTER_DELETE_FAILED") {
      await stateStore.pause({
        expectedRevision: revision,
        reason: "LIFECYCLE_AFTER_DELETE_FAILED",
      });
      armFromDecision({ nextWakeAt: null, reason: "halt" });
      return {
        success: false,
        status: "halted",
        errorCode: "LIFECYCLE_AFTER_DELETE_FAILED",
      };
    }

    // success path
    if (bumpResult.success === true && bumpResult.status === "succeeded") {
      const successAtMs = clock.now();
      const successAt = formatSuccessAtIso(successAtMs);
      const jitter = computeJitterMs(random(), config.cooldownJitterMs);
      if (!jitter.ok) {
        await stateStore.pause({
          expectedRevision: revision,
          reason: "SCHEDULER_RANDOM_INVALID",
        });
        armFromDecision({ nextWakeAt: null, reason: "halt" });
        return {
          success: false,
          status: "halted",
          errorCode: "SCHEDULER_RANDOM_INVALID",
        };
      }
      const nextEligibleMs = computeNextEligibleAtMs(
        successAtMs,
        config.cooldownMs,
        jitter.jitterMs,
      );
      const nextEligibleAt = toUtcIso(nextEligibleMs);
      const doneLocalDate = successLocalDate(successAtMs, config.timezone);

      // reload for latest revision after lifecycle
      const latest = await loadStateOrFail();
      if (!latest.ok) {
        armFromDecision({ nextWakeAt: null, reason: "halt" });
        return { success: false, status: "state_failed", errorCode: latest.errorCode };
      }
      revision = latest.state.revision;

      const complete = await stateStore.completeSuccess({
        expectedRevision: revision,
        operationId,
        localDate: doneLocalDate,
        successAt,
        nextEligibleAt,
      });
      if (!complete.success) {
        await stateStore.pause({
          expectedRevision: revision,
          reason: complete.errorCode || "STATE_WRITE_FAILED",
        });
        armFromDecision({ nextWakeAt: null, reason: "halt" });
        return {
          success: false,
          status: "state_failed",
          errorCode: complete.errorCode,
        };
      }
      state = complete.state;
      const d = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "ready",
      });
      // after success, prefer cooldown-based wake
      const cool = decideNextWakeAt({
        nowMs: clock.now(),
        config,
        state,
        reason: "cooldown",
      });
      armFromDecision(cool.nextWakeAt != null ? cool : d);
      return {
        success: true,
        status: "succeeded",
        errorCode: null,
        sentMessageId: bumpResult.sentMessageId,
        nextWakeAt: cool.nextWakeAt ?? d.nextWakeAt,
        diagnosticsComplete: bumpResult.diagnosticsComplete,
      };
    }

    // generic failure before inflight (client not ready etc.)
    if (!state?.inFlight) {
      const def = await stateStore.deferUntil({
        expectedRevision: revision,
        nextEligibleAt: toUtcIso(clock.now() + config.failureBackoffMs),
      });
      if (def.success) state = def.state;
      const d = decideNextWakeAt({
        nowMs: clock.now(), config, state, reason: "failure_backoff",
      });
      armFromDecision(d);
      return {
        success: false,
        status: "failed",
        errorCode: bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
        nextWakeAt: d.nextWakeAt,
      };
    }

    // unknown with inflight: halt
    await stateStore.pause({
      expectedRevision: revision,
      reason: bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
    });
    armFromDecision({ nextWakeAt: null, reason: "halt" });
    return {
      success: false,
      status: "halted",
      errorCode: bumpResult.errorCode || "BUMP_UNEXPECTED_FAILED",
    };
  }

  return {
    start,
    stop,
    runOnce,
    getStatus,
  };
}
