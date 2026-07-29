/**
 * Forum Bump Runtime：组装 Scanner / Bump Service / State Store / Scheduler，
 * 对接 bot 生命周期、Alert Outbox 与动态配置控制。
 *
 * 不读取 process.env / NODE_ENV / TEST_MODE。
 * disabled 不触碰状态文件与动态配置文件。
 */

import { resolve } from "path";
import { scanForumCandidates } from "./forumScanner.js";
import { createForumBumpService } from "./bumpService.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler } from "./scheduler.js";
import {
  applyDynamicConfigOverlay,
  toSchedulerConfig,
} from "../../config/forumBumpConfig.js";
import {
  createForumBumpAlertHandler,
  buildSafeInFlightSummary,
  mapCycleResultToIncidentKey,
} from "./runtimeAlerts.js";
import {
  baselineDynamicConfigFromEnv,
  FORUM_BUMP_DYNAMIC_CONFIG_PATH,
  cloneDynamicConfig,
  mergeDynamicConfigPatch,
} from "./dynamicConfigSchema.js";
import { createForumBumpDynamicConfigStore } from "./dynamicConfigStore.js";
import {
  computeAutoInterval,
  recomputeNextEligibleAfterConfigChange,
} from "./autoInterval.js";
import { preflightForumChannels } from "./forumPreflight.js";

/** 允许管理员 resume 的 pauseReason */
export const ADMIN_RESUMABLE_PAUSE_REASONS = Object.freeze(["ADMIN_PAUSED"]);

/**
 * @param {object} options
 */
export function createForumBumpRuntime({
  client,
  config,
  logger,
  alertNotifier = null,
  statePath = null,
  dynamicConfigPath = null,
  clock = { now: () => Date.now() },
  timers = null,
  random = Math.random,
  /** 终止类告警写入失败时的致命通道（Bot 注入） */
  onCriticalFailure = null,
  // 可注入（测试）
  createStateStoreFn = createForumBumpStateStore,
  createBumpServiceFn = createForumBumpService,
  createSchedulerFn = createForumBumpScheduler,
  createDynamicConfigStoreFn = createForumBumpDynamicConfigStore,
  scanCandidatesFn = null,
  preflightForumsFn = preflightForumChannels,
} = {}) {
  if (!config || typeof config !== "object") {
    throw new TypeError("createForumBumpRuntime 需要 config");
  }

  /** 部署基线（.env）；动态四项由 effectiveForumBump 覆盖 */
  const baseForumBump = { ...(config.forumBump ?? config) };
  const mode = baseForumBump.mode ?? "disabled";
  const guildId = baseForumBump.guildId ?? config.discordGuildId ?? null;
  const resolvedStatePath = statePath
    ?? baseForumBump.statePath
    ?? resolve("data/runtime/forum-bump/state.json");
  const resolvedDynamicConfigPath = dynamicConfigPath
    ?? baseForumBump.dynamicConfigPath
    ?? resolve(FORUM_BUMP_DYNAMIC_CONFIG_PATH);

  let started = false;
  let fatal = false;
  let fatalCode = null;
  let scheduler = null;
  let stateStore = null;
  let dynamicConfigStore = null;
  /** 当前有效 Forum 配置（基线 + 动态覆盖） */
  let effectiveForumBump = { ...baseForumBump };
  /** 当前动态配置文档（文件或内存基线） */
  let dynamicConfigDoc = null;
  let dynamicConfigSource = "env"; // env | file | failed
  let dynamicConfigError = null;
  let lastCycleResult = null;
  let startResult = null;
  let criticalFired = false;
  /** 控制操作串行队列 */
  let controlQueue = Promise.resolve();

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
      dynamicConfigSource,
      dynamicConfigError,
      scheduler: scheduler ? scheduler.getStatus() : null,
    };
  }

  function enqueueControl(fn) {
    const task = controlQueue.then(fn, fn);
    controlQueue = task.then(() => {}, () => {});
    return task;
  }

  function autoIntervalSummary(fb = effectiveForumBump) {
    const auto = computeAutoInterval(fb.activeStart, fb.activeEnd, fb.dailyLimit);
    if (!auto.ok) {
      return {
        autoIntervalMinutes: null,
        autoIntervalMs: null,
        intervalErrorCode: auto.errorCode,
      };
    }
    return {
      autoIntervalMinutes: auto.intervalMinutes,
      autoIntervalMs: auto.intervalMs,
      intervalErrorCode: null,
    };
  }

  /**
   * 面板/控制用安全快照。
   */
  async function getControlSnapshot() {
    const interval = autoIntervalSummary();
    let stateSnap = null;
    if (stateStore && mode !== "disabled") {
      try {
        await stateStore.load();
        stateSnap = stateStore.getSnapshot?.() ?? null;
      } catch {
        stateSnap = stateStore.getSnapshot?.() ?? null;
      }
    }
    const schedStatus = scheduler ? scheduler.getStatus() : null;
    return {
      mode,
      started,
      fatal,
      fatalCode,
      paused: stateSnap?.paused === true,
      pauseReason: stateSnap?.pauseReason ?? null,
      successCount: stateSnap?.successCount ?? 0,
      dailyLimit: effectiveForumBump.dailyLimit ?? null,
      lastSuccessAt: stateSnap?.lastSuccessAt ?? null,
      nextEligibleAt: stateSnap?.nextEligibleAt ?? null,
      inFlightPhase: stateSnap?.inFlight?.phase ?? null,
      activeStart: effectiveForumBump.activeStart ?? null,
      activeEnd: effectiveForumBump.activeEnd ?? null,
      forumChannelIds: Array.isArray(effectiveForumBump.forumChannelIds)
        ? [...effectiveForumBump.forumChannelIds]
        : [],
      silenceDays: effectiveForumBump.silenceDays ?? null,
      autoIntervalMinutes: interval.autoIntervalMinutes,
      autoIntervalMs: interval.autoIntervalMs,
      nextWakeAt: schedStatus?.nextWakeAt ?? null,
      running: schedStatus?.running === true,
      dynamicConfigSource,
      dynamicConfigRevision: dynamicConfigDoc?.revision ?? null,
      dynamicConfigError,
    };
  }

  async function loadEffectiveDynamicConfig() {
    dynamicConfigStore = createDynamicConfigStoreFn({
      configPath: resolvedDynamicConfigPath,
      logger,
      clock,
    });
    const loaded = await dynamicConfigStore.load();
    if (loaded.success && loaded.config) {
      dynamicConfigDoc = cloneDynamicConfig(loaded.config);
      dynamicConfigSource = "file";
      dynamicConfigError = null;
      effectiveForumBump = applyDynamicConfigOverlay(baseForumBump, dynamicConfigDoc);
      return { ok: true, source: "file" };
    }
    if (loaded.errorCode === "DYNAMIC_CONFIG_NOT_FOUND") {
      dynamicConfigDoc = baselineDynamicConfigFromEnv(baseForumBump, {
        updatedAt: null,
      });
      // 校验基线间隔
      const auto = computeAutoInterval(
        dynamicConfigDoc.activeStart,
        dynamicConfigDoc.activeEnd,
        dynamicConfigDoc.dailyLimit,
      );
      if (!auto.ok) {
        dynamicConfigSource = "failed";
        dynamicConfigError = auto.errorCode;
        return { ok: false, errorCode: auto.errorCode };
      }
      effectiveForumBump = applyDynamicConfigOverlay(baseForumBump, dynamicConfigDoc);
      dynamicConfigSource = "env";
      dynamicConfigError = null;
      return { ok: true, source: "env" };
    }
    // 损坏 / 非法 / 版本不支持：fail closed
    dynamicConfigSource = "failed";
    dynamicConfigError = loaded.errorCode || "DYNAMIC_CONFIG_INVALID";
    dynamicConfigDoc = null;
    return { ok: false, errorCode: dynamicConfigError };
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

    // dry_run / execute：加载动态配置（损坏则 fail closed，不启 timer）
    const dyn = await loadEffectiveDynamicConfig();
    if (!dyn.ok) {
      started = true;
      startResult = {
        success: false,
        mode,
        started: true,
        errorCode: dyn.errorCode || "DYNAMIC_CONFIG_INVALID",
        timerArmed: false,
        nextWakeAt: null,
        halted: true,
        dynamicConfigError: dyn.errorCode,
      };
      if (alertHandler) {
        try {
          await alertHandler.handleCycleResult({
            status: "state_failed",
            errorCode: startResult.errorCode,
          });
        } catch (alertErr) {
          fireCriticalOnce({
            errorCode: "ALERT_PERSISTENCE_FAILED",
            status: "state_failed",
            errorName: typeof alertErr?.name === "string" ? alertErr.name : "Error",
          });
        }
      }
      try {
        logger?.error?.("[ForumBumpRuntime] 动态配置不可用，fail closed", {
          errorCode: startResult.errorCode,
        });
      } catch {
        // ignore
      }
      return startResult;
    }

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

    let schedConfig;
    try {
      schedConfig = toSchedulerConfig(effectiveForumBump);
    } catch (error) {
      started = true;
      startResult = {
        success: false,
        mode,
        started: true,
        errorCode: typeof error?.code === "string" ? error.code : "SCHEDULER_CONFIG_INVALID",
        timerArmed: false,
        nextWakeAt: null,
        halted: true,
      };
      stateStore = null;
      return startResult;
    }

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

  /**
   * 热更新动态配置：全有或全无。
   * @param {object} patch
   * @param {{ actorId?: string, actorTag?: string }|null} [actorContext]
   */
  async function updateDynamicConfig(patch, actorContext = null) {
    return enqueueControl(async () => {
      if (mode === "disabled") {
        return {
          success: false,
          errorCode: "DYNAMIC_CONFIG_ARGUMENT_INVALID",
          safeMessage: "disabled 模式不支持动态配置。",
        };
      }
      if (!started || fatal) {
        return {
          success: false,
          errorCode: "DYNAMIC_CONFIG_UPDATE_FAILED",
          safeMessage: "Runtime 未就绪。",
        };
      }
      if (dynamicConfigSource === "failed" || !dynamicConfigDoc) {
        return {
          success: false,
          errorCode: dynamicConfigError || "DYNAMIC_CONFIG_INVALID",
          safeMessage: "动态配置不可用。",
        };
      }
      if (!scheduler || !stateStore || !dynamicConfigStore) {
        return {
          success: false,
          errorCode: "DYNAMIC_CONFIG_UPDATE_FAILED",
          safeMessage: "Scheduler/State 未就绪。",
        };
      }

      const previousEffective = { ...effectiveForumBump };
      const previousDoc = cloneDynamicConfig(dynamicConfigDoc);
      const previousSchedConfig = scheduler.getConfig();

      try {
        // 1. 等待当前周期安全结束
        await scheduler.waitUntilIdle();

        // 2. 合并 + 校验
        let merged;
        try {
          merged = mergeDynamicConfigPatch(dynamicConfigDoc, patch);
        } catch (error) {
          return {
            success: false,
            errorCode: error?.code || error?.errorCode || "DYNAMIC_CONFIG_INVALID",
            safeMessage: error?.safeMessage || "配置校验失败。",
          };
        }

        // 3. 新增 Forum Preflight
        const oldSet = new Set(previousDoc.forumChannelIds);
        const added = merged.forumChannelIds.filter((id) => !oldSet.has(id));
        if (added.length > 0) {
          const pf = await preflightForumsFn({
            client,
            guildId,
            forumChannelIds: added,
          });
          if (!pf.success) {
            return {
              success: false,
              errorCode: "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
              safeMessage: "新增 Forum Preflight 失败。",
              failures: pf.failures ?? [],
            };
          }
        }

        // 4. 确认无 inFlight
        await stateStore.load();
        let snap = stateStore.getSnapshot?.();
        if (snap?.inFlight) {
          return {
            success: false,
            errorCode: "DYNAMIC_CONFIG_INFLIGHT_BLOCKED",
            safeMessage: "存在未完成 inFlight，拒绝更新配置。",
            inFlightPhase: snap.inFlight.phase ?? null,
          };
        }

        const actor = actorContext?.actorTag
          || actorContext?.actorId
          || null;

        // 5. 原子持久化
        const expectedRevision = dynamicConfigDoc.revision;
        const saved = await dynamicConfigStore.save({
          config: merged,
          expectedRevision,
          updatedBy: actor,
        });
        if (!saved.success) {
          return {
            success: false,
            errorCode: saved.errorCode || "DYNAMIC_CONFIG_WRITE_FAILED",
            safeMessage: "动态配置持久化失败。",
          };
        }

        // 6. 热替换 Runtime / Scheduler 配置
        const nextEffective = applyDynamicConfigOverlay(baseForumBump, saved.config);
        let nextSchedConfig;
        try {
          nextSchedConfig = toSchedulerConfig(nextEffective);
          scheduler.replaceConfig(nextSchedConfig);
        } catch (error) {
          // 回滚磁盘：写回 previousDoc（best effort）
          try {
            await dynamicConfigStore.save({
              config: previousDoc,
              expectedRevision: saved.revision,
              updatedBy: "rollback",
            });
          } catch {
            // ignore
          }
          dynamicConfigDoc = previousDoc;
          effectiveForumBump = previousEffective;
          try {
            scheduler.replaceConfig(previousSchedConfig);
          } catch {
            // ignore
          }
          return {
            success: false,
            errorCode: error?.code || "DYNAMIC_CONFIG_UPDATE_FAILED",
            safeMessage: "热替换配置失败，已回滚。",
          };
        }

        dynamicConfigDoc = cloneDynamicConfig(saved.config);
        effectiveForumBump = nextEffective;
        dynamicConfigSource = "file";
        dynamicConfigError = null;

        // 7–8. 重算 nextEligibleAt + 清 timer 重排
        await stateStore.load();
        snap = stateStore.getSnapshot?.();
        if (!snap) {
          // 状态丢失：保留新配置但无 timer
          try {
            scheduler.clearSchedule?.();
          } catch {
            // ignore
          }
          return {
            success: false,
            errorCode: "STATE_READ_FAILED",
            safeMessage: "配置已保存但状态不可读。",
            config: cloneDynamicConfig(dynamicConfigDoc),
          };
        }

        if (!snap.paused && !snap.inFlight) {
          const recomputed = recomputeNextEligibleAfterConfigChange({
            nowMs: clock.now(),
            config: nextSchedConfig,
            state: snap,
          });
          if (recomputed.nextEligibleAt) {
            const def = await stateStore.deferUntil({
              expectedRevision: snap.revision,
              nextEligibleAt: recomputed.nextEligibleAt,
            });
            if (!def.success) {
              // 配置已写入；尽量恢复旧 scheduler 配置并无 timer
              try {
                scheduler.replaceConfig(previousSchedConfig);
                scheduler.clearSchedule?.();
              } catch {
                // ignore
              }
              // 配置文件保持新值（已成功），但排程失败 → 仍报告失败并清 timer
              try {
                await scheduler.rescheduleFromState({ reason: "halt" });
              } catch {
                // ignore
              }
              return {
                success: false,
                errorCode: def.errorCode || "STATE_WRITE_FAILED",
                safeMessage: "配置已保存但 nextEligibleAt 更新失败。",
                config: cloneDynamicConfig(dynamicConfigDoc),
                partial: true,
              };
            }
          }
        }

        // 暂停中：不 arm
        if (snap.paused) {
          try {
            scheduler.clearSchedule?.();
          } catch {
            // ignore
          }
          return {
            success: true,
            config: cloneDynamicConfig(dynamicConfigDoc),
            rescheduled: false,
            reason: "paused",
            autoIntervalMinutes: autoIntervalSummary().autoIntervalMinutes,
          };
        }

        const arm = await scheduler.rescheduleFromState({ reason: "ready" });
        if (!arm.success && arm.errorCode) {
          return {
            success: false,
            errorCode: arm.errorCode,
            safeMessage: "配置已保存但重新排程失败。",
            config: cloneDynamicConfig(dynamicConfigDoc),
            partial: true,
          };
        }

        try {
          logger?.info?.("[ForumBumpRuntime] dynamic config updated", {
            revision: dynamicConfigDoc.revision,
            dailyLimit: dynamicConfigDoc.dailyLimit,
            nextWakeAt: arm.nextWakeAt ?? null,
          });
        } catch {
          // ignore
        }

        return {
          success: true,
          config: cloneDynamicConfig(dynamicConfigDoc),
          rescheduled: arm.timerArmed === true,
          nextWakeAt: arm.nextWakeAt ?? null,
          autoIntervalMinutes: autoIntervalSummary().autoIntervalMinutes,
        };
      } catch (error) {
        // 尽力恢复旧配置内存态
        try {
          effectiveForumBump = previousEffective;
          dynamicConfigDoc = previousDoc;
          if (scheduler && previousSchedConfig) {
            scheduler.replaceConfig(previousSchedConfig);
            await scheduler.rescheduleFromState({ reason: "ready" });
          }
        } catch {
          // ignore
        }
        return {
          success: false,
          errorCode: typeof error?.code === "string"
            ? error.code
            : "DYNAMIC_CONFIG_UPDATE_FAILED",
          safeMessage: "配置热更新异常，已尝试回滚。",
        };
      }
    });
  }

  /**
   * 管理员暂停 Forum 自动顶帖。
   */
  async function pauseByAdmin(actorContext = null) {
    return enqueueControl(async () => {
      if (mode === "disabled") {
        return { success: false, errorCode: "DYNAMIC_CONFIG_ARGUMENT_INVALID" };
      }
      if (!started || !scheduler || !stateStore) {
        return { success: false, errorCode: "DYNAMIC_CONFIG_UPDATE_FAILED" };
      }

      await scheduler.waitUntilIdle();
      await stateStore.load();
      const snap = stateStore.getSnapshot?.();
      if (!snap) {
        return { success: false, errorCode: "STATE_READ_FAILED" };
      }

      // 幂等：已是 ADMIN_PAUSED
      if (snap.paused === true && snap.pauseReason === "ADMIN_PAUSED") {
        try {
          scheduler.clearSchedule?.();
        } catch {
          // ignore
        }
        return {
          success: true,
          idempotent: true,
          paused: true,
          pauseReason: "ADMIN_PAUSED",
        };
      }

      // 已因安全故障暂停：不覆盖原因
      if (snap.paused === true && snap.pauseReason !== "ADMIN_PAUSED") {
        try {
          scheduler.clearSchedule?.();
        } catch {
          // ignore
        }
        return {
          success: false,
          errorCode: "STATE_PAUSED",
          pauseReason: snap.pauseReason,
          safeMessage: "当前已因安全故障暂停，不覆盖 pauseReason。",
        };
      }

      const p = await stateStore.pause({
        expectedRevision: snap.revision,
        reason: "ADMIN_PAUSED",
      });
      if (!p.success) {
        return {
          success: false,
          errorCode: p.errorCode || "STATE_WRITE_FAILED",
        };
      }

      try {
        scheduler.clearSchedule?.();
      } catch {
        // ignore
      }

      try {
        logger?.info?.("[ForumBumpRuntime] admin paused", {
          actor: actorContext?.actorId ?? null,
        });
      } catch {
        // ignore
      }

      return {
        success: true,
        paused: true,
        pauseReason: "ADMIN_PAUSED",
        nextWakeAt: null,
      };
    });
  }

  /**
   * 管理员恢复：仅 ADMIN_PAUSED 且 inFlight=null。
   */
  async function resumeByAdmin(actorContext = null) {
    return enqueueControl(async () => {
      if (mode === "disabled") {
        return { success: false, errorCode: "DYNAMIC_CONFIG_ARGUMENT_INVALID" };
      }
      if (!started || !scheduler || !stateStore) {
        return { success: false, errorCode: "DYNAMIC_CONFIG_UPDATE_FAILED" };
      }
      if (dynamicConfigSource === "failed") {
        return {
          success: false,
          errorCode: dynamicConfigError || "DYNAMIC_CONFIG_INVALID",
          safeMessage: "动态配置无效，拒绝恢复。",
        };
      }

      await scheduler.waitUntilIdle();
      await stateStore.load();
      const snap = stateStore.getSnapshot?.();
      if (!snap) {
        return { success: false, errorCode: "STATE_READ_FAILED" };
      }

      // 未暂停：幂等
      if (!snap.paused) {
        const arm = await scheduler.rescheduleFromState({ reason: "ready" });
        return {
          success: true,
          idempotent: true,
          paused: false,
          nextWakeAt: arm.nextWakeAt ?? null,
        };
      }

      if (!ADMIN_RESUMABLE_PAUSE_REASONS.includes(snap.pauseReason)) {
        return {
          success: false,
          errorCode: "STATE_RECOVERY_REQUIRED",
          pauseReason: snap.pauseReason,
          safeMessage: "该暂停原因不允许管理员直接恢复。",
        };
      }

      if (snap.inFlight) {
        return {
          success: false,
          errorCode: "STATE_RECOVERY_REQUIRED",
          inFlightPhase: snap.inFlight.phase ?? null,
          safeMessage: "存在 inFlight，拒绝恢复。",
        };
      }

      const r = await stateStore.resume({ expectedRevision: snap.revision });
      if (!r.success) {
        return {
          success: false,
          errorCode: r.errorCode || "STATE_WRITE_FAILED",
        };
      }

      // 按当前动态配置重排
      await stateStore.load();
      const after = stateStore.getSnapshot?.();
      if (after && !after.paused) {
        const schedCfg = scheduler.getConfig();
        const recomputed = recomputeNextEligibleAfterConfigChange({
          nowMs: clock.now(),
          config: schedCfg,
          state: after,
        });
        if (recomputed.nextEligibleAt) {
          await stateStore.deferUntil({
            expectedRevision: after.revision,
            nextEligibleAt: recomputed.nextEligibleAt,
          });
        }
      }

      const arm = await scheduler.rescheduleFromState({ reason: "ready" });

      try {
        logger?.info?.("[ForumBumpRuntime] admin resumed", {
          actor: actorContext?.actorId ?? null,
          nextWakeAt: arm.nextWakeAt ?? null,
        });
      } catch {
        // ignore
      }

      return {
        success: true,
        paused: false,
        nextWakeAt: arm.nextWakeAt ?? null,
        timerArmed: arm.timerArmed === true,
      };
    });
  }

  return {
    start,
    stop,
    getStatus,
    getControlSnapshot,
    updateDynamicConfig,
    pauseByAdmin,
    resumeByAdmin,
    getScheduler: () => scheduler,
    getStateStore: () => stateStore,
    getDynamicConfigStore: () => dynamicConfigStore,
    getEffectiveForumBump: () => ({ ...effectiveForumBump }),
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
