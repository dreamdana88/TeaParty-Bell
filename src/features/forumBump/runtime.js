/**
 * Forum Bump Runtime：组装 Scanner / Bump Service / State Store / Scheduler，
 * 对接 bot 生命周期与 Alert Outbox。
 *
 * 不读取 process.env / NODE_ENV / TEST_MODE。
 * disabled 不触碰状态文件。
 */

import { resolve } from "path";
import { scanForumCandidates } from "./forumScanner.js";
import { createForumBumpService } from "./bumpService.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler } from "./scheduler.js";
import { toSchedulerConfig } from "../../config/forumBumpConfig.js";
import {
  createForumBumpAlertHandler,
  buildSafeInFlightSummary,
  mapCycleResultToIncidentKey,
} from "./runtimeAlerts.js";

/**
 * @param {object} options
 */
export function createForumBumpRuntime({
  client,
  config,
  logger,
  alertNotifier = null,
  statePath = null,
  clock = { now: () => Date.now() },
  timers = null,
  random = Math.random,
  /** 终止类告警写入失败时的致命通道（Bot 注入） */
  onCriticalFailure = null,
  // 可注入（测试）
  createStateStoreFn = createForumBumpStateStore,
  createBumpServiceFn = createForumBumpService,
  createSchedulerFn = createForumBumpScheduler,
  scanCandidatesFn = null,
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("createForumBumpRuntime 需要 config");
  }

  const forumBump = config.forumBump ?? config;
  const mode = forumBump.mode ?? "disabled";
  const guildId = forumBump.guildId ?? config.discordGuildId ?? null;
  const resolvedStatePath = statePath
    ?? forumBump.statePath
    ?? resolve("data/runtime/forum-bump/state.json");

  let started = false;
  let fatal = false;
  let fatalCode = null;
  let scheduler = null;
  let stateStore = null;
  let lastCycleResult = null;
  let startResult = null;
  let criticalFired = false;

  const alertHandler = alertNotifier
    ? createForumBumpAlertHandler({ alertNotifier, logger, guildId })
    : null;

  function getStatus() {
    return {
      mode,
      started,
      fatal,
      fatalCode,
      lastCycleResult,
      startResult,
      scheduler: scheduler ? scheduler.getStatus() : null,
    };
  }

  function fireCriticalOnce(context) {
    if (criticalFired) return;
    criticalFired = true;
    fatal = true;
    fatalCode = context?.errorCode ?? "ALERT_PERSISTENCE_FAILED";
    try {
      logger?.error?.("[ForumBumpRuntime] critical failure", {
        errorCode: fatalCode,
        status: context?.status ?? null,
        errorName: context?.errorName ?? null,
      });
    } catch {
      // ignore
    }
    if (typeof onCriticalFailure === "function") {
      try {
        const ret = onCriticalFailure({
          errorCode: fatalCode,
          status: context?.status ?? null,
          errorName: context?.errorName ?? "Error",
        });
        if (ret && typeof ret.then === "function") {
          ret.catch(() => {});
        }
      } catch {
        // 致命回调不得再抛到 Scheduler
      }
    }
  }

  async function haltSchedulerAfterAlertFailure() {
    if (scheduler) {
      try {
        await scheduler.stop();
      } catch {
        // ignore
      }
    }
    // stop 后引用保留到 stop() 清理；timer 已由 scheduler.stop 清除
  }

  /**
   * 周期结果 → 告警；终止类告警写盘失败 → 停 Scheduler + 致命通道。
   * 本身不 throw 到 Scheduler（由 safeOnCycleResult 保证）。
   */
  async function processCycleResult(result) {
    lastCycleResult = result;
    if (!alertHandler) return;
    const incidentKey = mapCycleResultToIncidentKey(result);
    try {
      await alertHandler.handleCycleResult(result);
    } catch (error) {
      try {
        logger?.error?.("[ForumBumpRuntime] cycle alert failed", {
          errorName: typeof error?.name === "string" ? error.name : "Error",
          status: result?.status ?? null,
          incidentKey,
        });
      } catch {
        // ignore
      }
      // 仅终止类 incident 升级致命
      if (incidentKey) {
        await haltSchedulerAfterAlertFailure();
        fireCriticalOnce({
          errorCode: "ALERT_PERSISTENCE_FAILED",
          status: result?.status ?? null,
          errorName: typeof error?.name === "string" ? error.name : "Error",
        });
      }
    }
  }

  function safeOnCycleResult(result) {
    Promise.resolve()
      .then(() => processCycleResult(result))
      .catch(() => {
        // 已内部消化；禁止 unhandled rejection
      });
  }

  async function start() {
    if (fatal) {
      return {
        success: false,
        mode,
        started: false,
        fatal: true,
        errorCode: fatalCode || "ALERT_PERSISTENCE_FAILED",
        timerArmed: false,
        nextWakeAt: null,
      };
    }

    if (started) {
      return {
        ...(startResult ?? {
          success: true,
          mode,
          started: true,
          timerArmed: false,
          nextWakeAt: null,
        }),
        started: true,
        idempotent: true,
        success: startResult?.success !== false,
      };
    }

    if (mode === "disabled") {
      started = true;
      startResult = {
        success: true,
        mode: "disabled",
        started: true,
        timerArmed: false,
        nextWakeAt: null,
        recoveryStatus: null,
      };
      // disabled 不得把遗留 Forum incident 当作已恢复
      try {
        logger?.info?.("[ForumBumpRuntime] disabled — 不创建 Runtime 组件，不恢复 Forum incident");
      } catch {
        // ignore
      }
      return startResult;
    }

    // dry_run / execute
    stateStore = createStateStoreFn({
      statePath: resolvedStatePath,
      logger,
    });

    const bumpService = mode === "execute"
      ? createBumpServiceFn({ client, logger, clock })
      : {
        bumpThread: async () => {
          throw new Error("dry_run must not call bumpService");
        },
      };

    const scanCandidates = scanCandidatesFn
      ?? (async (params) => scanForumCandidates({
        client,
        guildId: params.guildId,
        forumIds: params.forumIds,
        silenceDays: params.silenceDays,
        excludedTagIds: params.excludedTagIds,
        skipPinned: params.skipPinned,
        displayLimit: params.displayLimit ?? 1,
        clock: params.clock ?? clock,
        logger,
      }));

    const schedConfig = toSchedulerConfig(forumBump);

    scheduler = createSchedulerFn({
      scanCandidates,
      bumpService,
      stateStore,
      logger,
      clock,
      timers: timers ?? undefined,
      random,
      onCycleResult: safeOnCycleResult,
      config: schedConfig,
    });

    let result;
    try {
      result = await scheduler.start();
    } catch (error) {
      started = false;
      scheduler = null;
      stateStore = null;
      startResult = {
        success: false,
        mode,
        errorCode: typeof error?.code === "string" ? error.code : "SCHEDULER_UNEXPECTED_FAILED",
        timerArmed: false,
        nextWakeAt: null,
      };
      if (alertHandler) {
        try {
          await alertHandler.handleCycleResult({
            status: "unexpected_failed",
            errorCode: startResult.errorCode,
          });
        } catch (alertErr) {
          fireCriticalOnce({
            errorCode: "ALERT_PERSISTENCE_FAILED",
            status: "unexpected_failed",
            errorName: typeof alertErr?.name === "string" ? alertErr.name : "Error",
          });
          startResult.errorCode = "ALERT_PERSISTENCE_FAILED";
        }
      }
      return startResult;
    }

    if (!result?.success) {
      startResult = {
        success: false,
        mode,
        errorCode: result?.errorCode ?? "SCHEDULER_START_FAILED",
        recoveryStatus: result?.recoveryStatus ?? null,
        timerArmed: false,
        nextWakeAt: null,
        started: false,
      };
      if (alertHandler) {
        const status = result?.errorCode === "STATE_NOT_FOUND"
          || result?.errorCode === "STATE_READ_FAILED"
          || result?.errorCode === "STATE_INVALID"
          || result?.errorCode === "STATE_RECOVERY_FAILED"
          || result?.errorCode === "STATE_WRITE_FAILED"
          ? "state_failed"
          : "unexpected_failed";
        try {
          await alertHandler.handleCycleResult({
            status,
            errorCode: startResult.errorCode,
            inFlightSummary: result?.inFlightSummary ?? null,
          });
        } catch (alertErr) {
          fireCriticalOnce({
            errorCode: "ALERT_PERSISTENCE_FAILED",
            status,
            errorName: typeof alertErr?.name === "string" ? alertErr.name : "Error",
          });
          startResult.errorCode = "ALERT_PERSISTENCE_FAILED";
        }
      }
      scheduler = null;
      stateStore = null;
      return startResult;
    }

    // recovery 非 clean：无 timer，发告警（含 inFlight 摘要）
    const recovery = result.recoveryStatus;
    if (recovery && recovery !== "clean") {
      started = true;
      const summary = result.inFlightSummary
        ?? buildSafeInFlightSummary(
          (await safeLoadSnapshot(stateStore))?.inFlight,
        );
      startResult = {
        success: true,
        mode,
        started: true,
        recoveryStatus: recovery,
        cleanupRequired: result.cleanupRequired === true,
        timerArmed: false,
        nextWakeAt: null,
        halted: true,
        inFlightSummary: summary,
      };
      if (alertHandler) {
        const statusMap = {
          manual_review_required: "manual_review_required",
          cleanup_required: "cleanup_required",
          reconciliation_required: "reconciliation_required",
        };
        try {
          await alertHandler.handleCycleResult({
            status: statusMap[recovery] ?? "halted",
            errorCode: "STATE_RECOVERY_REQUIRED",
            cleanupRequired: result.cleanupRequired === true,
            inFlightSummary: summary,
            sentMessageId: summary?.sentMessageId ?? null,
            operationId: summary?.operationId ?? null,
            inFlightPhase: summary?.inFlightPhase ?? null,
          });
        } catch (alertErr) {
          fireCriticalOnce({
            errorCode: "ALERT_PERSISTENCE_FAILED",
            status: statusMap[recovery] ?? "halted",
            errorName: typeof alertErr?.name === "string" ? alertErr.name : "Error",
          });
        }
      }
      try {
        logger?.warn?.("[ForumBumpRuntime] 启动恢复待处理，无 timer", {
          recoveryStatus: recovery,
          inFlightPhase: summary?.inFlightPhase ?? null,
        });
      } catch {
        // ignore
      }
      return startResult;
    }

    // 磁盘 paused
    if (result.timerArmed === false && result.nextWakeAt == null) {
      let snap = null;
      try {
        await stateStore.load();
        snap = stateStore.getSnapshot?.();
      } catch {
        snap = null;
      }
      if (snap?.paused) {
        started = true;
        const summary = buildSafeInFlightSummary(snap.inFlight);
        startResult = {
          success: true,
          mode,
          started: true,
          recoveryStatus: "clean",
          paused: true,
          pauseReason: snap.pauseReason ?? null,
          timerArmed: false,
          nextWakeAt: null,
          halted: true,
          inFlightSummary: summary,
        };
        if (alertHandler) {
          try {
            await alertHandler.handleCycleResult({
              status: "halted",
              errorCode: snap.pauseReason ?? "PAUSED",
              pauseReason: snap.pauseReason ?? null,
              inFlightSummary: summary,
            });
          } catch (alertErr) {
            fireCriticalOnce({
              errorCode: "ALERT_PERSISTENCE_FAILED",
              status: "halted",
              errorName: typeof alertErr?.name === "string" ? alertErr.name : "Error",
            });
          }
        }
        return startResult;
      }
    }

    started = true;
    startResult = {
      success: true,
      mode,
      started: true,
      recoveryStatus: result.recoveryStatus ?? "clean",
      timerArmed: result.timerArmed === true,
      nextWakeAt: result.nextWakeAt ?? null,
      halted: false,
    };

    // 健康启动 → 仅 Forum Runtime 定向恢复 Forum incident
    if (alertHandler) {
      let clean = true;
      try {
        await stateStore.load();
        const snap = stateStore.getSnapshot?.();
        if (snap?.paused || snap?.inFlight) clean = false;
      } catch {
        clean = false;
      }
      if (clean && startResult.recoveryStatus === "clean" && !startResult.halted) {
        try {
          await alertHandler.notifyHealthyRecoveries();
        } catch (error) {
          startResult = {
            success: false,
            mode,
            errorCode: "ALERT_PERSISTENCE_FAILED",
            timerArmed: false,
            nextWakeAt: null,
          };
          if (scheduler) {
            try {
              await scheduler.stop();
            } catch {
              // ignore
            }
          }
          started = false;
          scheduler = null;
          stateStore = null;
          fireCriticalOnce({
            errorCode: "ALERT_PERSISTENCE_FAILED",
            status: "recovery",
            errorName: typeof error?.name === "string" ? error.name : "Error",
          });
          throw error;
        }
      }
    }

    try {
      logger?.info?.("[ForumBumpRuntime] started", {
        mode,
        timerArmed: startResult.timerArmed,
      });
    } catch {
      // ignore
    }
    return startResult;
  }

  async function stop() {
    if (!started && !scheduler) {
      return { success: true, stopped: true, idempotent: true };
    }
    if (scheduler) {
      try {
        await scheduler.stop();
      } catch (error) {
        try {
          logger?.error?.("[ForumBumpRuntime] stop failed", {
            errorName: typeof error?.name === "string" ? error.name : "Error",
          });
        } catch {
          // ignore
        }
      }
    }
    scheduler = null;
    stateStore = null;
    started = false;
    return { success: true, stopped: true };
  }

  return {
    start,
    stop,
    getStatus,
    getScheduler: () => scheduler,
    getStateStore: () => stateStore,
    processCycleResult,
  };
}

async function safeLoadSnapshot(stateStore) {
  try {
    await stateStore.load();
    return stateStore.getSnapshot?.() ?? null;
  } catch {
    return null;
  }
}
