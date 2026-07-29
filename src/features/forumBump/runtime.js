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
import { createForumBumpAlertHandler } from "./runtimeAlerts.js";

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
  let scheduler = null;
  let stateStore = null;
  let lastCycleResult = null;
  let startResult = null;

  const alertHandler = alertNotifier
    ? createForumBumpAlertHandler({ alertNotifier, logger, guildId })
    : null;

  function getStatus() {
    return {
      mode,
      started,
      lastCycleResult,
      startResult,
      scheduler: scheduler ? scheduler.getStatus() : null,
    };
  }

  async function onCycleResult(result) {
    lastCycleResult = result;
    if (!alertHandler) return;
    try {
      await alertHandler.handleCycleResult(result);
    } catch (error) {
      try {
        logger?.error?.("[ForumBumpRuntime] cycle alert failed", {
          errorName: typeof error?.name === "string" ? error.name : "Error",
          status: result?.status ?? null,
        });
      } catch {
        // ignore
      }
      // 告警失败向上抛由调用方（runOnce 回调已吞）处理；
      // 对 start 路径的关键告警另有检查。
      throw error;
    }
  }

  /**
   * 安全包装：Scheduler 内 emit 已 try/catch；此处再保证 Runtime 侧不因 alert 崩溃。
   * 但 start 时对 recovery/halt 的关键失败仍 fail-closed。
   */
  function safeOnCycleResult(result) {
    lastCycleResult = result;
    if (!alertHandler) return;
    Promise.resolve()
      .then(() => alertHandler.handleCycleResult(result))
      .catch((error) => {
        try {
          logger?.error?.("[ForumBumpRuntime] cycle alert failed", {
            errorName: typeof error?.name === "string" ? error.name : "Error",
            status: result?.status ?? null,
          });
        } catch {
          // ignore
        }
      });
  }

  async function start() {
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
      try {
        logger?.info?.("[ForumBumpRuntime] disabled — 不创建 Runtime 组件");
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
        // dry_run 占位：Scheduler 不会调用
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
        await alertHandler.handleCycleResult({
          status: "unexpected_failed",
          errorCode: startResult.errorCode,
        });
      }
      return startResult;
    }

    if (!result?.success) {
      // 启动失败：告警并保持无 timer
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
          ? "state_failed"
          : "unexpected_failed";
        await alertHandler.handleCycleResult({
          status,
          errorCode: startResult.errorCode,
        });
      }
      // 不标记 started，允许诊断后重试；但 bot 层应 fail closed
      scheduler = null;
      stateStore = null;
      return startResult;
    }

    // recovery 非 clean：无 timer，发告警，其他 bot 功能可继续
    const recovery = result.recoveryStatus;
    if (recovery && recovery !== "clean") {
      started = true;
      startResult = {
        success: true,
        mode,
        started: true,
        recoveryStatus: recovery,
        cleanupRequired: result.cleanupRequired === true,
        timerArmed: false,
        nextWakeAt: null,
        halted: true,
      };
      if (alertHandler) {
        const statusMap = {
          manual_review_required: "manual_review_required",
          cleanup_required: "cleanup_required",
          reconciliation_required: "reconciliation_required",
        };
        await alertHandler.handleCycleResult({
          status: statusMap[recovery] ?? "halted",
          errorCode: "STATE_RECOVERY_REQUIRED",
          cleanupRequired: result.cleanupRequired === true,
        });
      }
      try {
        logger?.warn?.("[ForumBumpRuntime] 启动恢复待处理，无 timer", {
          recoveryStatus: recovery,
        });
      } catch {
        // ignore
      }
      return startResult;
    }

    // 磁盘 paused：无 timer
    if (result.timerArmed === false && result.nextWakeAt == null) {
      // 可能是 paused / disabled config — 检查 snapshot
      let snap = null;
      try {
        await stateStore.load();
        snap = stateStore.getSnapshot?.();
      } catch {
        snap = null;
      }
      if (snap?.paused) {
        started = true;
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
        };
        if (alertHandler) {
          await alertHandler.handleCycleResult({
            status: "halted",
            errorCode: snap.pauseReason ?? "PAUSED",
            pauseReason: snap.pauseReason ?? null,
          });
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

    // 健康启动 → recovery 事件
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
          // 关键 recovery 持久化失败 → fail closed
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
    /** 测试/诊断 */
    getScheduler: () => scheduler,
    getStateStore: () => stateStore,
    onCycleResult,
  };
}
